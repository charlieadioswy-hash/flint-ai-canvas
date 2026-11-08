-- PostgreSQL：为已启用的 Liblib F.1-dev-fp8 追加常用 1K 比例的明确像素规格。
-- 官方自定义模型文生图宽高范围为 128–1536；F.1 推荐 768–1536。
-- 来源：https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d#FCbudAMnComRQQx8XyscpVhAnhj
-- 不开放超出模板直接输出范围的 2K / 4K，不启用任意自定义尺寸。
-- 仅追加 image.size.values / presets，不改默认尺寸、其他能力、生成参数或价格。
-- 执行前备份；必须用 -v expected_capability_version=<读取的版本> 指定基线。
-- 预演加 -v dry_run=true；正式执行去掉 dry_run，提交后递增 Redis 路由目录版本。

\set ON_ERROR_STOP on
\if :{?expected_capability_version}
\else
  \echo '必须提供 expected_capability_version，禁止覆盖未知版本的配置'
  \quit 1
\endif
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('yingce.liblib_f1_sizes_expected_version', :'expected_capability_version', true);

DO $configure$
DECLARE
    selected_model channel_models%ROWTYPE;
    expected_version bigint := current_setting('yingce.liblib_f1_sizes_expected_version')::bigint;
    old_config jsonb;
    next_config jsonb;
    next_values jsonb;
    next_presets jsonb;
    preset jsonb;
    desired_presets CONSTANT jsonb := $json$[
        {"size":"1024x1024","tier":"1k","ratio":"1:1","width":1024,"height":1024},
        {"size":"1280x720","tier":"1k","ratio":"16:9","width":1280,"height":720},
        {"size":"720x1280","tier":"1k","ratio":"9:16","width":720,"height":1280},
        {"size":"1024x768","tier":"1k","ratio":"4:3","width":1024,"height":768},
        {"size":"768x1024","tier":"1k","ratio":"3:4","width":768,"height":1024},
        {"size":"1152x768","tier":"1k","ratio":"3:2","width":1152,"height":768},
        {"size":"768x1152","tier":"1k","ratio":"2:3","width":768,"height":1152},
        {"size":"896x1120","tier":"1k","ratio":"4:5","width":896,"height":1120},
        {"size":"1120x896","tier":"1k","ratio":"5:4","width":1120,"height":896},
        {"size":"1344x576","tier":"1k","ratio":"21:9","width":1344,"height":576}
    ]$json$::jsonb;
BEGIN
    SELECT m.* INTO STRICT selected_model
    FROM channel_models m JOIN model_channels c ON c.id = m.channel_id
    WHERE lower(c.name) = 'liblib' AND c.scope = 'system' AND c.deleted_at IS NULL AND c.enabled
      AND m.deleted_at IS NULL AND m.enabled AND m.protocol = 'liblib-image' AND m.capability = 'image'
      AND m.model_key = '412b427ddb674b4dbab9e5abd5ae6057'
      AND m.provider_model_key = '412b427ddb674b4dbab9e5abd5ae6057'
    FOR UPDATE OF m, c;
    IF selected_model.provider_defaults::jsonb ->> 'family' IS DISTINCT FROM 'f1'
       OR selected_model.provider_defaults::jsonb ->> 'textToImageTemplateUuid' IS DISTINCT FROM '6f7c4652458d4802969f8d089cf5b91f'
       OR selected_model.provider_defaults::jsonb ->> 'imageToImageTemplateUuid' IS DISTINCT FROM '63b72710c9574457ba303d9d9b8df8bd'
       OR coalesce(selected_model.provider_defaults::jsonb ->> 'templateUuid', '') <> '' THEN
        RAISE EXCEPTION 'F.1 生成模板已变化，停止以保护管理员配置';
    END IF;
    old_config := selected_model.capability_config_json::jsonb;
    IF old_config #>> '{image,size,parameter}' IS DISTINCT FROM 'size'
       OR old_config #> '{image,size,allowCustom}' IS DISTINCT FROM 'false'::jsonb
       OR jsonb_typeof(old_config #> '{image,size,values}') IS DISTINCT FROM 'array'
       OR jsonb_typeof(coalesce(old_config #> '{image,size,presets}', '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'F.1 尺寸配置不符合受限像素预设基线，停止以保护管理员配置';
    END IF;
    next_values := old_config #> '{image,size,values}';
    next_presets := coalesce(old_config #> '{image,size,presets}', '[]'::jsonb);
    FOR preset IN SELECT value FROM jsonb_array_elements(desired_presets) LOOP
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(next_presets) existing
            WHERE existing ->> 'tier' = preset ->> 'tier' AND existing ->> 'ratio' = preset ->> 'ratio'
              AND (existing ->> 'size' IS DISTINCT FROM preset ->> 'size'
                   OR (existing ? 'width' AND existing -> 'width' IS DISTINCT FROM preset -> 'width')
                   OR (existing ? 'height' AND existing -> 'height' IS DISTINCT FROM preset -> 'height'))
        ) THEN
            RAISE EXCEPTION 'F.1 已有自定义 1K 比例 % 的像素规格，停止且不覆盖', preset ->> 'ratio';
        END IF;
        IF NOT next_values @> jsonb_build_array(preset ->> 'size') THEN
            next_values := next_values || jsonb_build_array(preset ->> 'size');
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(next_presets) existing
            WHERE existing ->> 'tier' = preset ->> 'tier' AND existing ->> 'ratio' = preset ->> 'ratio'
        ) THEN
            next_presets := next_presets || jsonb_build_array(preset);
        END IF;
    END LOOP;
    next_config := jsonb_set(jsonb_set(old_config, '{image,size,values}', next_values),
                             '{image,size,presets}', next_presets);
    IF old_config = next_config THEN
        RAISE NOTICE '模型 % 的 1K 比例已配置，无需修改', selected_model.id;
        RETURN;
    END IF;
    IF selected_model.capability_version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION '模型能力版本已变化，停止以保护管理员配置';
    END IF;
    UPDATE channel_models SET capability_config_json = next_config::text,
        capability_version = capability_version + 1, updated_at = now()
    WHERE id = selected_model.id AND capability_version = expected_version;
    IF NOT FOUND THEN
        RAISE EXCEPTION '模型并发更新，停止';
    END IF;
    RAISE NOTICE '模型 % 已补齐 10 种 1K 比例，能力版本 % -> %',
        selected_model.id, expected_version, expected_version + 1;
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
