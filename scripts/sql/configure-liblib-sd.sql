-- PostgreSQL: 为已存在的 liblib 系统渠道添加 SDK 文档示例 SD 模型。
-- 来源：https://www.npmjs.com/package/liblibai/v/0.0.11 （Text to Image / Image to Image）。
-- 官方接口文档：https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d
-- 飞书原文当前无法直接抓取；这里使用 SDK 发布包示例，不声明上游已实测可用。
-- 用户指定本站售价：1 积分/张，即 1000000 microcredits；上游成本未配置。
-- 当前图片计价为 fixed_request，限制每次输出 1 张，保证每张 1 积分。
-- 不读取、不修改 AK/SK，不创建渠道，不修改其他渠道、已有前台模型或线路。
-- 使用 psql -X -v ON_ERROR_STOP=1 -f scripts/sql/configure-liblib-sd.sql 执行。
-- 默认事务提交；演练时先设置 psql 变量 dry_run=true，验证完成后回滚。
-- 写入后递增 Redis 的 canvas:logical-model-route-catalog:version 使目录缓存失效。
--
-- 上游模型 ID = checkPointId = 0ea388c7eb854be3ba3c6f65aac6bfd3。
-- templateUuid 是请求模板，不能用作该 SD 模型的上游模型 ID。
-- 当前模型表不支持 providerOptions 默认值；画布「生成参数」仍需填写：
-- 文生图：family=sd，templateUuid=e10adc3949ba59abbe56e057f20f883e，
-- steps=20，sampler=15，cfgScale=7，seed=-1，尺寸 768x1024。
-- 图生图：templateUuid=9c7d531dc75f476aa833b3d452b8f7ad，
-- 另填 denoisingStrength=0.75，并提供一张普通参考图。
-- 暂不声明 ControlNet 模型兼容性；确认匹配的控制模型 UUID 后再启用。

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

DO $configure$
DECLARE
    channel_record model_channels%ROWTYPE;
    model_record channel_models%ROWTYPE;
    tier_record channel_model_price_tiers%ROWTYPE;
    checkpoint CONSTANT text := '0ea388c7eb854be3ba3c6f65aac6bfd3';
    sequence_value bigint;
    next_model_id text;
    next_tier_id text;
    capability_config CONSTANT text := $json${
      "version": 1,
      "image": {
        "references": {"promptMaxChars": 2000, "maxImages": 1, "maxImageBytes": 10485760, "maskSupported": false},
        "size": {"parameter": "size", "values": ["768x1024"], "default": "768x1024", "allowCustom": false},
        "quality": {"supported": false, "values": [], "default": "auto"},
        "transparentBackground": {"supported": false, "default": false},
        "responseFormat": {"supported": false},
        "outputFormat": {"supported": false},
        "controlNet": {"supported": false, "maxUnits": 4, "preprocessors": ["canny"]},
        "maxOutputs": 1
      }
    }$json$;
BEGIN
    -- STRICT 拒绝找不到渠道或存在多个同名渠道，行锁串行化重复执行。
    SELECT * INTO STRICT channel_record FROM model_channels
    WHERE lower(name) = 'liblib' AND scope = 'system' AND deleted_at IS NULL
    FOR UPDATE;
    IF channel_record.enabled IS DISTINCT FROM true
       OR rtrim(channel_record.base_url, '/') IS DISTINCT FROM 'https://openapi.liblibai.cloud'
       OR coalesce(channel_record.api_key, '') = '' OR coalesce(channel_record.secret_key, '') = '' THEN
        RAISE EXCEPTION 'liblib 渠道必须已启用、配置官方地址并保存 AK/SK';
    END IF;

    SELECT * INTO model_record FROM channel_models
    WHERE channel_id = channel_record.id AND model_key = checkpoint AND deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO id_sequences (name, value, updated_at)
        VALUES ('id:MODEL', 0, now()) ON CONFLICT (name) DO NOTHING;
        UPDATE id_sequences SET value = greatest(coalesce(value, 0),
            (SELECT coalesce(max(substring(id FROM '^MODEL_([0-9]+)$')::bigint), 0) FROM channel_models)) + 1,
            updated_at = now() WHERE name = 'id:MODEL' RETURNING value INTO sequence_value;
        next_model_id := 'MODEL_' || lpad(sequence_value::text, greatest(6, length(sequence_value::text)), '0');
        INSERT INTO channel_models (
            id, channel_id, model_key, provider_model_key, display_name, channel_label,
            tags, description, sort_order, icon, capability, protocol, billing_mode,
            unit_price_microcredits, input_token_price_microcredits, output_token_price_microcredits,
            cached_token_price_microcredits, price_configured, enabled, price_version,
            capability_config_json, capability_version, created_at, updated_at
        ) VALUES (
            next_model_id, channel_record.id, checkpoint, checkpoint, 'Liblib SD 文档示例', 'Liblib SD',
            '[]', 'SDK 示例基础模型。生成参数：family=sd，steps=20，sampler=15，cfgScale=7；文生图模板 e10adc3949ba59abbe56e057f20f883e；图生图模板 9c7d531dc75f476aa833b3d452b8f7ad，denoisingStrength=0.75。未执行真实生成验证。',
            0, '', 'image', 'liblib-image', 'fixed_request',
            1000000, 0, 0, 0, true, true, 1, capability_config, 1, now(), now()
        ) RETURNING * INTO model_record;
    END IF;
    IF model_record.protocol IS DISTINCT FROM 'liblib-image' OR model_record.capability IS DISTINCT FROM 'image'
       OR model_record.provider_model_key IS DISTINCT FROM checkpoint THEN
        RAISE EXCEPTION '同名模型已存在但协议不同，停止以保护已有配置';
    END IF;

    SELECT * INTO tier_record FROM channel_model_price_tiers
    WHERE channel_model_id = model_record.id AND selector_key = '{}' AND deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO id_sequences (name, value, updated_at)
        VALUES ('id:PTIER', 0, now()) ON CONFLICT (name) DO NOTHING;
        UPDATE id_sequences SET value = greatest(coalesce(value, 0),
            (SELECT coalesce(max(substring(id FROM '^PTIER_([0-9]+)$')::bigint), 0) FROM channel_model_price_tiers)) + 1,
            updated_at = now() WHERE name = 'id:PTIER' RETURNING value INTO sequence_value;
        next_tier_id := 'PTIER_' || lpad(sequence_value::text, greatest(6, length(sequence_value::text)), '0');
        INSERT INTO channel_model_price_tiers (
            id, channel_model_id, selector_key, selector_json, resolution, video_seconds,
            provider_model_key, billing_mode, unit_price_microcredits, input_token_price_microcredits,
            output_token_price_microcredits, cached_token_price_microcredits, price_configured,
            enabled, price_version, created_at, updated_at
        ) VALUES (
            next_tier_id, model_record.id, '{}', '{}', '*', 0, checkpoint,
            'fixed_request', 1000000, 0, 0, 0, true, true, 1, now(), now()
        ) RETURNING * INTO tier_record;
    END IF;
    IF model_record.enabled IS DISTINCT FROM true OR model_record.price_configured IS DISTINCT FROM true
       OR model_record.unit_price_microcredits IS DISTINCT FROM 1000000
       OR model_record.billing_mode IS DISTINCT FROM 'fixed_request'
       OR (model_record.capability_config_json::jsonb #>> '{image,maxOutputs}') IS DISTINCT FROM '1'
       OR tier_record.enabled IS DISTINCT FROM true OR tier_record.price_configured IS DISTINCT FROM true
       OR tier_record.unit_price_microcredits IS DISTINCT FROM 1000000
       OR tier_record.billing_mode IS DISTINCT FROM 'fixed_request'
       OR tier_record.provider_model_key IS DISTINCT FROM checkpoint THEN
        RAISE EXCEPTION '已有模型或价格档与 1 积分/张配置不同，请人工检查，不自动覆盖';
    END IF;

    UPDATE model_channels SET models_json = (
        SELECT coalesce(json_agg(model_key ORDER BY sort_order, id), '[]'::json)::text
        FROM channel_models WHERE channel_id = channel_record.id AND deleted_at IS NULL AND enabled
    ), updated_at = now() WHERE id = channel_record.id AND models_json IS DISTINCT FROM (
        SELECT coalesce(json_agg(model_key ORDER BY sort_order, id), '[]'::json)::text
        FROM channel_models WHERE channel_id = channel_record.id AND deleted_at IS NULL AND enabled
    );
    RAISE NOTICE '渠道 %, 模型 %, 价格档 % 已校验：1 积分/张', channel_record.id, model_record.id, tier_record.id;
END
$configure$;

\if :{?dry_run}
  \if :dry_run
    ROLLBACK;
  \else
    COMMIT;
  \endif
\else
  COMMIT;
\endif
