-- Read-only, targeted JSON Lines backup of the paths changed by this repair.
-- No credentials, provider defaults, price records or full database contents.
-- psql -X -qAt -v repair_environment=development|production -f this-file.sql > backup.jsonl
\set ON_ERROR_STOP on
\if :{?repair_environment}
\else
  \echo 'Required psql variable: repair_environment (development or production)'
  \quit 3
\endif
SELECT :'repair_environment' IN ('development', 'production') AS valid_environment,
       :'repair_environment' = 'development' AS development \gset
\if :valid_environment
\else
  \echo 'repair_environment must be development or production'
  \quit 3
\endif
\if :development
  \set channel_id CHANNEL_000001
  \set expected_count 3
  \set protocol_id openai-image
  \set models '{"MODEL_000006":"gpt-image-1.5","MODEL_000016":"gpt-image-2","MODEL_000009":"gpt-image-2.5-sunburst"}'
\else
  \set channel_id CHANNEL_000002
  \set expected_count 1
  \set protocol_id volcengine-ark-image
  \set models '{"MODEL_000003":"doubao-seedream-5-0-pro-260628"}'
\endif

BEGIN READ ONLY;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) = :expected_count AS complete_backup
FROM channel_models cm JOIN model_channels channel ON channel.id = cm.channel_id
WHERE channel.id = :'channel_id' AND channel.scope = 'system' AND channel.deleted_at IS NULL
  AND cm.deleted_at IS NULL AND :'models'::jsonb ->> cm.id = cm.model_key
  AND cm.provider_model_key = cm.model_key AND cm.protocol = :'protocol_id' AND cm.capability = 'image' \gset
\if :complete_backup
\else
  \echo 'Audited model identity mismatch: backup aborted'
  ROLLBACK;
  \quit 3
\endif
SELECT jsonb_build_object(
    'id', cm.id, 'channelId', cm.channel_id, 'modelKey', cm.model_key, 'protocol', cm.protocol,
    'capabilityVersion', cm.capability_version, 'updatedAt', cm.updated_at,
    'paths', jsonb_build_object(
        'image.size.values', jsonb_build_object('present', config #> '{image,size,values}' IS NOT NULL, 'value', config #> '{image,size,values}'),
        'image.size.default', jsonb_build_object('present', config #> '{image,size,default}' IS NOT NULL, 'value', config #> '{image,size,default}')
    )
)
FROM channel_models cm CROSS JOIN LATERAL (SELECT cm.capability_config_json::jsonb AS config) decoded
WHERE cm.channel_id = :'channel_id' AND cm.deleted_at IS NULL AND :'models'::jsonb ? cm.id
ORDER BY cm.id;
COMMIT;
