-- PostgreSQL：为已存在的 Liblib Dream Tech XL 开放官方推荐的 SDXL 控制组合。
-- 仅从旧的 Canny-only 配置升级，不覆盖管理员后续自定义的白名单。
-- 来源：backend/internal/protocol/controlnet_catalog.json，官方预处理器推荐模型。
-- 11 类控制类型、46 个预处理器；none/invert 是预处理方式，不单独作为类型。
-- 不改模型 UUID 白名单、生成参数、价格、渠道密钥或其他模型能力。
-- 必须先备份，再通过 -v expected_capability_version=<读取的版本> 显式指定基线。
-- 预演加 -v dry_run=true；提交后递增 Redis 路由目录版本并刷新客户端。

\set ON_ERROR_STOP on
\if :{?expected_capability_version}
\else
  \echo '必须提供 expected_capability_version，禁止覆盖未知版本的配置'
  \quit 1
\endif
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('yingce.controlnet_expected_version', :'expected_capability_version', true);

DO $configure$
DECLARE
    selected_model channel_models%ROWTYPE;
    old_config jsonb;
    next_config jsonb;
    processors CONSTANT jsonb := $json$[
        "canny", "hed", "hed_safe", "pidinet", "pidinet_safe",
        "softedge_teed", "softedge_anyline", "scribble_pidinet", "scribble_xdog", "scribble_hed",
        "lineart_realistic", "lineart_standard", "lineart_coarse", "lineart_anime", "lineart_anime_denoise",
        "depth_midas", "depth_leres", "depth_leres++", "depth_zoe", "depth_hand_refiner", "depth_anything",
        "openpose", "openpose_hand", "openpose_face", "openpose_faceonly", "openpose_full", "dw_openpose_full",
        "densepose", "densepose_parula", "tile_resample", "tile_colorfix", "tile_colorfix+sharp", "blur_gaussian",
        "ip-adapter_clip_sdxl", "ip-adapter_clip_sdxl_plus_vith", "recolor_luminance", "recolor_intensity",
        "inpaint_global_harmonious", "inpaint_only", "inpaint_only+lama", "ip-adapter_face_id", "ip-adapter_face_id_plus",
        "instant_id_face_keypoints", "instant_id_face_embedding", "none", "invert"
    ]$json$::jsonb;
BEGIN
    SELECT m.* INTO STRICT selected_model
    FROM channel_models m JOIN model_channels c ON c.id = m.channel_id
    WHERE lower(c.name) = 'liblib' AND c.scope = 'system' AND c.deleted_at IS NULL AND c.enabled
      AND m.deleted_at IS NULL AND m.enabled AND m.protocol = 'liblib-image' AND m.capability = 'image'
      AND m.model_key = '0ea388c7eb854be3ba3c6f65aac6bfd3'
      AND m.provider_model_key = '0ea388c7eb854be3ba3c6f65aac6bfd3'
    FOR UPDATE OF m;
    old_config := selected_model.capability_config_json::jsonb;
    IF old_config #>> '{image,controlNet,supported}' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION '模型未启用 ControlNet，停止以保护既有配置';
    END IF;
    next_config := jsonb_set(jsonb_set(old_config, '{image,controlNet,baseModel}', '"sdxl"'::jsonb),
                             '{image,controlNet,preprocessors}', processors);
    IF old_config = next_config THEN
        RAISE NOTICE '模型 % 已配置，无需修改', selected_model.id;
        RETURN;
    END IF;
    IF selected_model.capability_version IS DISTINCT FROM current_setting('yingce.controlnet_expected_version')::bigint
       OR old_config #> '{image,controlNet,preprocessors}' IS DISTINCT FROM '["canny"]'::jsonb
       OR coalesce(old_config #>> '{image,controlNet,baseModel}', '') NOT IN ('', 'sdxl')
       OR coalesce(old_config #> '{image,controlNet,models}', 'null'::jsonb) NOT IN ('null'::jsonb, '[]'::jsonb) THEN
        RAISE EXCEPTION '模型能力版本或白名单已变化，停止以保护管理员配置';
    END IF;
    UPDATE channel_models SET capability_config_json = next_config::text,
        capability_version = capability_version + 1, updated_at = now()
    WHERE id = selected_model.id AND capability_version = selected_model.capability_version;
    IF NOT FOUND THEN
        RAISE EXCEPTION '模型并发更新，停止';
    END IF;
    RAISE NOTICE '模型 % 已开放 SDXL 的11类控制类型、46个预处理器', selected_model.id;
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
