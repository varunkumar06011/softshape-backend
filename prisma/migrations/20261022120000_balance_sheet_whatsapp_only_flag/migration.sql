-- The "Send to WhatsApp instead of Submit" balance sheet used to switch on when the
-- outlet name contained "vgrand". It is now a per-outlet setting
-- (enabledModules.balanceSheetWhatsappOnly); every other outlet keeps the default.
-- Turn it on for the outlets that had it, so nothing changes for them.
UPDATE "Outlet"
SET "enabledModules" = COALESCE("enabledModules", '{}'::jsonb) || '{"balanceSheetWhatsappOnly": true}'::jsonb
WHERE "id" IN ('cmqy60ci200027dscyj9ubg8h', 'cmr03m0fa00015ot8jh16grhn')
   OR LOWER("name") LIKE '%vgrand%'
   OR LOWER("name") LIKE '%v-grand%';
