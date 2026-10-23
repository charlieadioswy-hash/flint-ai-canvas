-- PostgreSQL phase 1: compatible with the currently deployed Wangsu plugin.
-- Only capability JSON is changed. Prices, enabled flags and provider defaults are preserved.
-- Required: -v channel_id=CHANNEL_... . Default: dry_run=true (ROLLBACK).
-- Run backup-wangsu-capabilities.sql first. See repair-wangsu-capabilities.md.
\set ON_ERROR_STOP on
\if :{?channel_id}
\else
  \echo 'Required psql variable: channel_id'
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
    resolutions jsonb;
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
          AND lower(model_key) IN ('doubao-seedance-2-0-fast-260128', 'gemini-nano-banana-2.1', 'minimax-hailuo-2.3')
        ORDER BY id FOR UPDATE
    LOOP
        model_count := model_count + 1;
        IF lower(selected_model.provider_model_key) IS DISTINCT FROM lower(selected_model.model_key) THEN
            RAISE EXCEPTION 'Unexpected upstream key for model %', selected_model.id;
        END IF;
        original := selected_model.capability_config_json::jsonb;
        patched := original;
        IF lower(selected_model.model_key) = 'gemini-nano-banana-2.1' THEN
            IF selected_model.capability IS DISTINCT FROM 'image'
               OR selected_model.protocol NOT IN ('wangsu-gemini-image', 'wangsu-chat-image')
               OR jsonb_typeof(original #> '{image,references,maxImages}') IS DISTINCT FROM 'number'
               OR (original #>> '{image,references,maxImages}') !~ '^[0-9]+$' THEN
                RAISE EXCEPTION 'Unexpected Nano reference contract for model %', selected_model.id;
            END IF;
            -- Keep any stricter administrator limit.
            IF (original #>> '{image,references,maxImages}')::integer > 14 THEN
                patched := jsonb_set(patched, '{image,references,maxImages}', '14'::jsonb);
            END IF;
        ELSE
            IF selected_model.capability IS DISTINCT FROM 'video' OR selected_model.protocol IS DISTINCT FROM 'wangsu-videos'
               OR jsonb_typeof(original #> '{video,resolutions}') IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'Unexpected video contract for model %', selected_model.id;
            END IF;
            IF lower(selected_model.model_key) = 'doubao-seedance-2-0-fast-260128' THEN
                IF jsonb_array_length(original #> '{video,resolutions}') = 0 OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(original #> '{video,resolutions}') value
                    WHERE lower(value) NOT IN ('480p', '720p', '4k')
                ) THEN
                    RAISE EXCEPTION 'Custom Seedance Fast resolutions require review: %', selected_model.id;
                END IF;
                SELECT coalesce(jsonb_agg(value ORDER BY ordinal), '[]'::jsonb) INTO resolutions
                FROM jsonb_array_elements(original #> '{video,resolutions}') WITH ORDINALITY item(value, ordinal)
                WHERE lower(value #>> '{}') <> '4k';
                IF jsonb_array_length(resolutions) = 0 THEN
                    RAISE EXCEPTION 'Seedance Fast has no verified resolution left: %', selected_model.id;
                END IF;
                patched := jsonb_set(patched, '{video,resolutions}', resolutions);
                IF NOT resolutions ? (original #>> '{video,defaultResolution}') THEN
                    patched := jsonb_set(patched, '{video,defaultResolution}',
                        CASE WHEN resolutions ? '720p' THEN '"720p"'::jsonb ELSE resolutions -> 0 END);
                END IF;
            ELSE
                IF original #> '{video,resolutions}' = '["480p"]'::jsonb
                   AND original #>> '{video,defaultResolution}' = '480p' THEN
                    patched := jsonb_set(patched, '{video,resolutions}', '["768P","1080P"]'::jsonb);
                    patched := jsonb_set(patched, '{video,defaultResolution}', '"768P"'::jsonb);
                ELSIF original #> '{video,resolutions}' IS DISTINCT FROM '["768P","1080P"]'::jsonb
                      OR original #>> '{video,defaultResolution}' IS DISTINCT FROM '768P' THEN
                    RAISE EXCEPTION 'Custom Hailuo 2.3 resolutions require review: %', selected_model.id;
                END IF;
            END IF;
        END IF;
        IF patched IS DISTINCT FROM original THEN
            UPDATE channel_models SET capability_config_json = patched::text,
                capability_version = coalesce(capability_version, 0) + 1, updated_at = now()
            WHERE id = selected_model.id;
            changed_count := changed_count + 1;
            RAISE NOTICE 'Changed capability paths only: % (%)', selected_model.id, selected_model.model_key;
        END IF;
    END LOOP;
    IF model_count <> 3 THEN
        RAISE EXCEPTION 'Expected exactly 3 audited models, found %', model_count;
    END IF;
    RAISE NOTICE 'Wangsu phase 1: % capability rows changed', changed_count;
END
$repair$;

\if :dry_run
  ROLLBACK;
\else
  COMMIT;
\endif
