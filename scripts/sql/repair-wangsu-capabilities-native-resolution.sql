-- PostgreSQL phase 2: requires the updated backend, frontend AND Wangsu plugin.
-- Required: -v channel_id=CHANNEL_... -v code_and_plugin_ready=true
-- Default: dry_run=true (ROLLBACK). See repair-wangsu-capabilities.md.
-- Keep existing quality-based image price selectors; updated code projects resolution onto them.
\set ON_ERROR_STOP on
\if :{?channel_id}
\else
  \echo 'Required psql variable: channel_id'
  \quit 3
\endif
\if :{?code_and_plugin_ready}
  \if :code_and_plugin_ready
  \else
    \echo 'Deploy the updated backend, frontend and Wangsu plugin before phase 2'
    \quit 3
  \endif
\else
  \echo 'Required psql variable: code_and_plugin_ready=true'
  \quit 3
\endif
\if :{?dry_run}
\else
  \set dry_run true
\endif
SELECT lower(:'dry_run') IN ('true', 'false') AS valid_dry_run \gset
\if :valid_dry_run
\else
  \echo 'dry_run must be exactly true or false'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('repair.wangsu_channel_id', :'channel_id', true);

DO $repair$
DECLARE
    selected_channel model_channels%ROWTYPE;
    selected_model channel_models%ROWTYPE;
    original jsonb;
    patched jsonb;
    old_ratios CONSTANT jsonb := '["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]';
    native_ratios CONSTANT jsonb := '["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9","1:4","1:8","4:1","8:1"]';
    resolution_config CONSTANT jsonb := '{"supported":true,"values":["1k","2k","4k"],"default":"1k"}';
    quality_config CONSTANT jsonb := '{"supported":false,"values":[],"default":"auto"}';
    model_count integer := 0;
    changed_count integer := 0;
BEGIN
    SELECT * INTO STRICT selected_channel FROM model_channels
    WHERE id = current_setting('repair.wangsu_channel_id')
      AND scope = 'system' AND deleted_at IS NULL FOR UPDATE;
    IF rtrim(selected_channel.base_url, '/') IS DISTINCT FROM 'https://api.edgecloudapp.com/v2/llm' THEN
        RAISE EXCEPTION 'Selected channel is not the audited Wangsu endpoint';
    END IF;
    FOR selected_model IN SELECT * FROM channel_models
        WHERE channel_id = selected_channel.id AND deleted_at IS NULL
          AND lower(model_key) IN ('gemini-3-pro-image', 'gemini-nano-banana-2.1', 'kling-v3', 'kling-v3-omni')
        ORDER BY id FOR UPDATE
    LOOP
        model_count := model_count + 1;
        IF lower(selected_model.provider_model_key) IS DISTINCT FROM lower(selected_model.model_key) THEN
            RAISE EXCEPTION 'Unexpected upstream key for model %', selected_model.id;
        END IF;
        original := selected_model.capability_config_json::jsonb;
        patched := original;
        IF lower(selected_model.model_key) IN ('gemini-3-pro-image', 'gemini-nano-banana-2.1') THEN
            IF selected_model.capability IS DISTINCT FROM 'image'
               OR selected_model.protocol NOT IN ('wangsu-gemini-image', 'wangsu-chat-image')
               OR original #>> '{image,size,parameter}' IS DISTINCT FROM 'aspect_ratio'
               OR original #> '{image,size,allowCustom}' IS DISTINCT FROM 'false'::jsonb
               OR coalesce(original #> '{image,size,presets}', '[]'::jsonb) <> '[]'::jsonb
               OR original #>> '{image,size,default}' IS DISTINCT FROM '1:1'
               OR (original #> '{image,size,values}' IS DISTINCT FROM old_ratios
                   AND (lower(selected_model.model_key) <> 'gemini-nano-banana-2.1' OR original #> '{image,size,values}' IS DISTINCT FROM native_ratios))
               OR (original #> '{image,quality}' IS DISTINCT FROM '{"supported":true,"values":["1k","2k","4k"],"default":"1k"}'::jsonb
                   AND original #> '{image,quality}' IS DISTINCT FROM quality_config)
               OR (original #> '{image,resolution}' IS NOT NULL AND original #> '{image,resolution}' IS DISTINCT FROM resolution_config
                   AND original #> '{image,resolution}' IS DISTINCT FROM '{"supported":false,"values":[],"default":"auto"}'::jsonb) THEN
                RAISE EXCEPTION 'Custom Gemini capability paths require review: %', selected_model.id;
            END IF;
            patched := jsonb_set(patched, '{image,resolution}', resolution_config);
            patched := jsonb_set(patched, '{image,quality}', quality_config);
            patched := jsonb_set(patched, '{image,resolutionUsesQuality}', 'false'::jsonb);
            IF lower(selected_model.model_key) = 'gemini-nano-banana-2.1' THEN
                IF (original #>> '{image,references,maxImages}')::integer > 14 THEN
                    RAISE EXCEPTION 'Apply phase 1 reference limit repair first: %', selected_model.id;
                END IF;
                patched := jsonb_set(patched, '{image,size,values}', native_ratios);
            END IF;
        ELSE
            IF selected_model.capability IS DISTINCT FROM 'video' OR selected_model.protocol IS DISTINCT FROM 'wangsu-videos'
               OR (original #> '{video,resolutions}' IS DISTINCT FROM '[]'::jsonb AND original #> '{video,resolutions}' IS DISTINCT FROM '["720P","1080P"]'::jsonb)
               OR (original #>> '{video,defaultResolution}' IS DISTINCT FROM '' AND original #>> '{video,defaultResolution}' IS DISTINCT FROM '1080P')
               OR (original #> '{video,ratios}' IS DISTINCT FROM '[]'::jsonb AND original #> '{video,ratios}' IS DISTINCT FROM '["16:9","9:16","1:1"]'::jsonb)
               OR (original #>> '{video,defaultRatio}' IS DISTINCT FROM '' AND original #>> '{video,defaultRatio}' IS DISTINCT FROM '16:9') THEN
                RAISE EXCEPTION 'Custom Kling capability paths require review: %', selected_model.id;
            END IF;
            patched := jsonb_set(patched, '{video,resolutions}', '["720P","1080P"]'::jsonb);
            patched := jsonb_set(patched, '{video,defaultResolution}', '"1080P"'::jsonb);
            patched := jsonb_set(patched, '{video,ratios}', '["16:9","9:16","1:1"]'::jsonb);
            patched := jsonb_set(patched, '{video,defaultRatio}', '"16:9"'::jsonb);
        END IF;
        IF patched IS DISTINCT FROM original THEN
            UPDATE channel_models SET capability_config_json = patched::text,
                capability_version = coalesce(capability_version, 0) + 1, updated_at = now()
            WHERE id = selected_model.id;
            changed_count := changed_count + 1;
            RAISE NOTICE 'Changed capability paths only: % (%)', selected_model.id, selected_model.model_key;
        END IF;
    END LOOP;
    IF model_count <> 4 THEN
        RAISE EXCEPTION 'Expected exactly 4 audited models, found %', model_count;
    END IF;
    RAISE NOTICE 'Wangsu phase 2: % capability rows changed', changed_count;
END
$repair$;

\if :dry_run
  ROLLBACK;
\else
  COMMIT;
\endif
