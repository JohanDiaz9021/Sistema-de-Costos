'use strict';

/**
 * Configuracion de umbrales (4.4) — rutas de /api/costeo.
 *
 * Se extrajo de src/routes/costeo.js, que habia llegado a 1.514 lineas
 * con ocho dominios distintos conviviendo en un archivo. El contenido
 * es el mismo, movido tal cual: lo unico nuevo es este encabezado.
 */

const express = require('express');
const { CONFIG_DEFAULTS } = require('../../queries/costo-common');
const { tablaRecargos } = require('../../queries/costo-recargos');
const { query } = require('../../db');
const { requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../queries/costo-audit');
const { CONFIG_DEFS } = require('./_shared');

const router = express.Router();

// ---------------------------------------------------------------
// Configuración de umbrales (4.4) — exclusivo admin/ceo. Lee/escribe
// mp_costeo_config para que estos valores se cambien sin tocar la base
// de datos directamente. getConfigNumber() (costo-common.js) ya lee esta
// misma tabla con fallback, así que un cambio aquí se refleja de inmediato
// en indicadores y alertas la próxima vez que se recalculen (sin reinicio).
// ---------------------------------------------------------------

router.get('/config', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const rows = await query('SELECT config_key, config_value, updated_at FROM mp_costeo_config');
    const byKey = new Map(rows.map((r) => [r.config_key, r]));
    const config = Object.entries(CONFIG_DEFS).map(([key, def]) => {
      const row = byKey.get(key);
      return {
        config_key: key,
        label: def.label,
        unit: def.unit,
        description: def.description,
        // El piso viaja al front para que el campo lo declare en el HTML y
        // el navegador ya no deje enviar un 0 donde rompe el cálculo. La
        // validación de verdad sigue siendo la del PUT — esto es la ayuda
        // visual, no la defensa.
        min: def.min ?? 0,
        config_value: row ? Number(row.config_value) : CONFIG_DEFAULTS[key],
        is_default: !row,
        updated_at: row ? row.updated_at : null,
      };
    });
    // Los 7 casos de la tabla de recargos de GTC, calculados con los
    // valores que acaban de leerse — no una copia escrita a mano en el
    // HTML, que se quedaría mintiendo apenas alguien edite un porcentaje.
    const valor = (k) => Number(config.find((c) => c.config_key === k)?.config_value ?? CONFIG_DEFAULTS[k]);
    const tabla_recargos = tablaRecargos({
      extraDiurnaPct: valor('recargo_extra_diurna_pct'),
      extraNocturnaPct: valor('recargo_extra_nocturna_pct'),
      nocturnoOrdinarioPct: valor('recargo_nocturno_ordinario_pct'),
      dominicalFestivoPct: valor('recargo_dominical_festivo_pct'),
    });

    res.json({ config, tabla_recargos, horas_mes: valor('horas_mes_liquidacion') });
  } catch (err) {
    next(err);
  }
});

// Sin requireRole a propósito: /config completo es de admin/ceo, pero el
// divisor de la fórmula lo necesita CUALQUIERA que dé de alta a alguien en
// un equipo (un PM, típicamente) para poder mostrar el valor hora mientras
// escribe el salario. Es un parámetro de cálculo, no un dato sensible, y
// sin él el formulario tendría que adivinar 210 y contradecir al servidor
// el día que ese número cambie.
router.get('/parametros-nomina', async (req, res, next) => {
  try {
    const rows = await query("SELECT config_value FROM mp_costeo_config WHERE config_key = 'horas_mes_liquidacion'");
    res.json({ horas_mes: rows.length ? Number(rows[0].config_value) : CONFIG_DEFAULTS.horas_mes_liquidacion });
  } catch (err) {
    next(err);
  }
});

router.put('/config/:key', requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const key = String(req.params.key);
    // hasOwnProperty y no `CONFIG_DEFS[key]` a secas: con la forma corta,
    // /config/constructor o /config/toString devuelven algo del prototipo de
    // Object, pasan el `if (!def)` y terminan insertando una fila basura en
    // mp_costeo_config con description undefined.
    if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFS, key)) {
      return res.status(400).json({ error: 'Umbral desconocido' });
    }
    const def = CONFIG_DEFS[key];

    // BUG DE DINERO corregido (2 sep 2026). Antes esto era `Number(...)` a
    // secas contra `isFinite() && >= 0`, y Number() convierte null, '', []
    // y false en 0 — los cuatro pasaban la validación y guardaban un "0"
    // que nadie escribió. Un formulario mal enviado bastaba para dejar
    // weekly_legal_hours en 0 y hacer que cada hora trabajada de la empresa
    // contara como hora extra, sin ningún error a la vista.
    //
    // Por eso se mira el tipo ANTES de convertir: solo un número o una
    // cadena numérica son entradas válidas aquí.
    const bruto = req.body.config_value;
    if (typeof bruto !== 'number' && typeof bruto !== 'string') {
      return res.status(400).json({ error: 'config_value debe ser un número' });
    }
    if (String(bruto).trim() === '') {
      return res.status(400).json({ error: 'config_value es obligatorio' });
    }

    const value = Number(bruto);
    // El piso lo declara cada umbral (CONFIG_DEFS en _shared.js): 0 es
    // legítimo en un recargo, pero no en los dos divisores del motor.
    const min = def.min ?? 0;
    if (!Number.isFinite(value) || value < min) {
      return res.status(400).json({
        error: min > 0
          ? `"${def.label}" debe ser un número mayor o igual a ${min} — con 0 el motor de cálculo deja de funcionar.`
          : 'config_value debe ser un número mayor o igual a 0',
      });
    }

    // Valor anterior ANTES del UPDATE, para dejar "de -> a" en el
    // historial — este número mueve dinero real en todos los proyectos
    // (ej. el recargo de horas extra o el umbral que dispara la alerta
    // crítica de presupuesto), así que quedaba justo el tipo de cambio que
    // hay que poder rastrear si algo sale mal después.
    const antesRows = await query('SELECT config_value FROM mp_costeo_config WHERE config_key = ?', [key]);
    const valorAntes = antesRows.length ? Number(antesRows[0].config_value) : CONFIG_DEFAULTS[key];

    await query(
      `INSERT INTO mp_costeo_config (config_key, config_value, description, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_by = VALUES(updated_by)`,
      [key, String(value), def.description, req.session.user.user_id || null]
    );

    await logAudit({
      costCenterId: null, entityType: 'config', entityId: null, action: 'editar',
      userId: req.session.user.user_id, userName: req.session.user.full_name,
      description: `${def.label}: ${valorAntes}${def.unit} → ${value}${def.unit}`,
    });

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
