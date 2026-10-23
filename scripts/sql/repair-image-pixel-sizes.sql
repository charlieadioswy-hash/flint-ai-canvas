-- Targeted PostgreSQL repair for the four audited channel models.
-- Required: -v repair_environment=development|production. Default: dry_run=true.
-- Run backup-image-pixel-sizes.sql first. See repair-image-pixel-sizes.md.
\set ON_ERROR_STOP on
\if :{?repair_environment}
\else
  \echo 'Required psql variable: repair_environment (development or production)'
  \quit 3
\endif
\if :{?dry_run}
\else
  \set dry_run true
\endif
SELECT :'repair_environment' IN ('development', 'production') AS valid_environment,
       lower(:'dry_run') IN ('true', 'false') AS valid_dry_run \gset
\if :valid_environment
\else
  \echo 'repair_environment must be development or production'
  \quit 3
\endif
\if :valid_dry_run
\else
  \echo 'dry_run must be exactly true or false'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE image_pixel_repair_targets (
    environment text, channel_id text, id text, model_key text, protocol text, pixel_default text
) ON COMMIT DROP;
INSERT INTO image_pixel_repair_targets VALUES
    ('development', 'CHANNEL_000001', 'MODEL_000006', 'gpt-image-1.5', 'openai-image', '1024x1024'),
    ('development', 'CHANNEL_000001', 'MODEL_000016', 'gpt-image-2', 'openai-image', '1024x1024'),
    ('development', 'CHANNEL_000001', 'MODEL_000009', 'gpt-image-2.5-sunburst', 'openai-image', '1024x1024'),
    ('production', 'CHANNEL_000002', 'MODEL_000003', 'doubao-seedream-5-0-pro-260628', 'volcengine-ark-image', '2048x2048');
DELETE FROM image_pixel_repair_targets WHERE environment <> :'repair_environment';

DO $repair$
DECLARE
    target record;
    selected_model channel_models%ROWTYPE;
    original jsonb;
    patched jsonb;
    old_values constant jsonb := '[
      "auto","1:1","3:2","2:3","4:3","3:4","16:9","21:9","9:16",
      "1024x1024","1360x1024","1024x1360","1536x1024","1024x1536",
      "1024x1280","1280x1024","2048x878","1824x1024","1024x1824",
      "2048x2048","2304x1728","1728x2304","2496x1664","1664x2496",
      "1792x2240","2240x1792","3136x1344","2752x1536","1536x2752",
      "2880x2880","3264x2448","2448x3264","3504x2336","2336x3504",
      "2560x3200","3200x2560","3808x1632","3840x2160","2160x3840"
    ]'::jsonb;
    pixel_values jsonb;
    changed_count integer := 0;
BEGIN
    SELECT jsonb_agg(value ORDER BY ordinal) INTO pixel_values
    FROM jsonb_array_elements(old_values) WITH ORDINALITY item(value, ordinal)
    WHERE value #>> '{}' !~ ':';

    FOR target IN SELECT * FROM image_pixel_repair_targets ORDER BY id LOOP
        PERFORM 1 FROM model_channels
        WHERE id = target.channel_id AND scope = 'system' AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Audited system channel is missing: %', target.channel_id;
        END IF;
        SELECT * INTO STRICT selected_model FROM channel_models
        WHERE id = target.id AND channel_id = target.channel_id AND deleted_at IS NULL FOR UPDATE;
        IF selected_model.capability IS DISTINCT FROM 'image'
           OR selected_model.model_key IS DISTINCT FROM target.model_key
           OR selected_model.provider_model_key IS DISTINCT FROM target.model_key
           OR selected_model.protocol IS DISTINCT FROM target.protocol THEN
            RAISE EXCEPTION 'Audited model identity changed: %', target.id;
        END IF;

        original := selected_model.capability_config_json::jsonb;
        IF original #>> '{image,size,parameter}' IS DISTINCT FROM 'size'
           OR original #> '{image,size,allowCustom}' IS DISTINCT FROM 'true'::jsonb
           OR (original #> '{image,size,presets}' IS NOT NULL
               AND original #> '{image,size,presets}' NOT IN ('null'::jsonb, '[]'::jsonb))
           OR (original #> '{image,parameters}' IS NOT NULL
               AND original #> '{image,parameters}' IS DISTINCT FROM 'null'::jsonb)
           OR coalesce(original #> '{image,resolution,supported}', 'false'::jsonb) NOT IN ('false'::jsonb, 'null'::jsonb) THEN
            RAISE EXCEPTION 'Custom image size contract requires review: %', target.id;
        END IF;

        IF original #> '{image,size,values}' = pixel_values
           AND original #>> '{image,size,default}' = target.pixel_default
           AND selected_model.capability_version >= 2 THEN
            RAISE NOTICE 'Already repaired: % (%)', target.id, target.model_key;
            CONTINUE;
        END IF;
        IF original #> '{image,size,values}' IS DISTINCT FROM old_values
           OR original #>> '{image,size,default}' IS DISTINCT FROM '1:1'
           OR selected_model.capability_version IS DISTINCT FROM 1::bigint THEN
            RAISE EXCEPTION 'Unexpected audited size values, default or version: %', target.id;
        END IF;

        patched := jsonb_set(original, '{image,size,values}', pixel_values);
        patched := jsonb_set(patched, '{image,size,default}', to_jsonb(target.pixel_default));
        UPDATE channel_models SET capability_config_json = patched::text,
            capability_version = capability_version + 1, updated_at = now()
        WHERE id = target.id;
        changed_count := changed_count + 1;
        RAISE NOTICE 'Repaired size values/default only: % (%)', target.id, target.model_key;
    END LOOP;
    RAISE NOTICE 'Image pixel size repair: % capability rows changed', changed_count;
END
$repair$;

SELECT cm.id, cm.model_key, cm.capability_version,
       cm.capability_config_json::jsonb #>> '{image,size,default}' AS size_default,
       jsonb_array_length(cm.capability_config_json::jsonb #> '{image,size,values}') AS size_count
FROM channel_models cm JOIN image_pixel_repair_targets target ON target.id = cm.id
ORDER BY cm.id;

\if :dry_run
  ROLLBACK;
\else
  COMMIT;
\endif
