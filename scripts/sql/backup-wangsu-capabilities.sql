-- Read-only JSON Lines backup of only the capability paths used by the two repair phases.
-- No credentials, channel configuration, pricing, enabled flags or unrelated model fields.
-- psql -X -qAt -v ON_ERROR_STOP=1 -v channel_id=CHANNEL_... -f this-file.sql > backup.jsonl
\set ON_ERROR_STOP on
\if :{?channel_id}
\else
  \echo 'Required psql variable: channel_id'
  \quit 3
\endif

BEGIN READ ONLY;
WITH selected AS (
    SELECT cm.id, cm.channel_id, cm.model_key, cm.protocol, cm.capability_version,
           cm.capability_config_json::jsonb AS config
    FROM channel_models cm
    JOIN model_channels channel ON channel.id = cm.channel_id
    WHERE channel.id = :'channel_id' AND channel.scope = 'system' AND channel.deleted_at IS NULL
      AND rtrim(channel.base_url, '/') = 'https://api.edgecloudapp.com/v2/llm'
      AND cm.deleted_at IS NULL AND lower(cm.provider_model_key) = lower(cm.model_key)
      AND ((lower(cm.model_key) IN ('doubao-seedance-2-0-fast-260128', 'minimax-hailuo-2.3', 'kling-v3', 'kling-v3-omni') AND cm.protocol = 'wangsu-videos')
           OR (lower(cm.model_key) IN ('gemini-3-pro-image', 'gemini-nano-banana-2.1') AND cm.protocol IN ('wangsu-gemini-image', 'wangsu-chat-image')))
), paths AS (
    SELECT selected.*, path FROM selected
    CROSS JOIN LATERAL (
        SELECT ARRAY['video','resolutions']::text[] AS path WHERE lower(model_key) IN ('doubao-seedance-2-0-fast-260128', 'minimax-hailuo-2.3', 'kling-v3', 'kling-v3-omni')
        UNION ALL SELECT ARRAY['video','defaultResolution'] WHERE lower(model_key) IN ('doubao-seedance-2-0-fast-260128', 'minimax-hailuo-2.3', 'kling-v3', 'kling-v3-omni')
        UNION ALL SELECT ARRAY['video','ratios'] WHERE lower(model_key) IN ('kling-v3', 'kling-v3-omni')
        UNION ALL SELECT ARRAY['video','defaultRatio'] WHERE lower(model_key) IN ('kling-v3', 'kling-v3-omni')
        UNION ALL SELECT ARRAY['image','references','maxImages'] WHERE lower(model_key) = 'gemini-nano-banana-2.1'
        UNION ALL SELECT ARRAY['image','size','values'] WHERE lower(model_key) = 'gemini-nano-banana-2.1'
        UNION ALL SELECT ARRAY['image','resolution'] WHERE lower(model_key) IN ('gemini-3-pro-image', 'gemini-nano-banana-2.1')
        UNION ALL SELECT ARRAY['image','quality'] WHERE lower(model_key) IN ('gemini-3-pro-image', 'gemini-nano-banana-2.1')
        UNION ALL SELECT ARRAY['image','resolutionUsesQuality'] WHERE lower(model_key) IN ('gemini-3-pro-image', 'gemini-nano-banana-2.1')
    ) affected
)
SELECT jsonb_build_object(
    'id', id, 'channelId', channel_id, 'modelKey', model_key, 'protocol', protocol,
    'capabilityVersion', capability_version,
    'paths', jsonb_object_agg(array_to_string(path, '.'), jsonb_build_object('present', config #> path IS NOT NULL, 'value', config #> path))
)
FROM paths GROUP BY id, channel_id, model_key, protocol, capability_version ORDER BY id;
COMMIT;
