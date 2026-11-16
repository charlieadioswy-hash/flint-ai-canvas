-- PostgreSQL：Liblib F.1 只开放两款已实测的裸眼 3D LoRA。
-- 停用通过移出可执行目录实现；执行前备份完整模型与原 LoRA 目录，以便恢复。
-- 必须提供 channel_model_id 和 expected_capability_version。
-- 默认事务演练；正式写入显式传入 -v dry_run=false。
-- 提交后递增 Redis 的 canvas:logical-model-route-catalog:version。

\set ON_ERROR_STOP on
\if :{?channel_model_id}
\else
  \echo '必须提供 channel_model_id'
  \quit 1
\endif
\if :{?expected_capability_version}
\else
  \echo '必须提供 expected_capability_version'
  \quit 1
\endif
\if :{?dry_run}
\else
  \set dry_run true
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('yingce.liblib_f1_3d_model_id', :'channel_model_id', true);
SELECT set_config('yingce.liblib_f1_3d_expected_version', :'expected_capability_version', true);

DO $configure$
DECLARE
    selected_model channel_models%ROWTYPE;
    expected_version bigint := current_setting('yingce.liblib_f1_3d_expected_version')::bigint;
    old_config jsonb;
    models jsonb;
    retained jsonb;
    existing jsonb;
    next_models jsonb;
    new_model CONSTANT jsonb := $json${
        "id": "8802aa18b81f49718df366ce960508db",
        "name": "xxxxxwFLUX裸眼3D",
        "baseModel": "f1",
        "triggerWords": ["huimeng3D"],
        "sourceUrl": "https://www.liblib.art/modelinfo/fd2bb6975c524141b1d85be009bedb57?versionUuid=8802aa18b81f49718df366ce960508db",
        "defaultWeight": 0.5
    }$json$::jsonb;
BEGIN
    SELECT m.* INTO STRICT selected_model
    FROM channel_models m JOIN model_channels c ON c.id = m.channel_id
    WHERE m.id = current_setting('yingce.liblib_f1_3d_model_id')
      AND c.scope = 'system' AND c.deleted_at IS NULL AND c.enabled AND lower(c.name) = 'liblib'
      AND m.deleted_at IS NULL AND m.enabled AND m.protocol = 'liblib-image' AND m.capability = 'image'
      AND m.model_key = '412b427ddb674b4dbab9e5abd5ae6057'
      AND m.provider_model_key = '412b427ddb674b4dbab9e5abd5ae6057'
    FOR UPDATE OF m, c;
    old_config := selected_model.capability_config_json::jsonb;
    IF selected_model.provider_defaults::jsonb ->> 'family' IS DISTINCT FROM 'f1'
       OR old_config #> '{image,lora,supported}' IS DISTINCT FROM 'true'::jsonb
       OR old_config #>> '{image,lora,baseModel}' IS DISTINCT FROM 'f1'
       OR jsonb_typeof(old_config #> '{image,lora,models}') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION '目标模型未启用 F.1 LoRA 目录，停止';
    END IF;
    models := old_config #> '{image,lora,models}';
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(models) item GROUP BY item ->> 'id' HAVING count(*) > 1) THEN
        RAISE EXCEPTION '目录存在重复版本，停止';
    END IF;
    SELECT item INTO STRICT retained FROM jsonb_array_elements(models) item
    WHERE item ->> 'id' = 'cb8ffe3f3fd54832bbd01885520b23d0';
    IF retained ->> 'baseModel' IS DISTINCT FROM 'f1' THEN
        RAISE EXCEPTION '需要保留的裸眼 3D LoRA 算法不匹配，停止';
    END IF;
    SELECT item INTO existing FROM jsonb_array_elements(models) item
    WHERE item ->> 'id' = new_model ->> 'id';
    IF FOUND THEN
        IF NOT existing @> new_model THEN
            RAISE EXCEPTION '新 LoRA 已有不同配置，停止以保护管理员设置';
        END IF;
    ELSE
        existing := new_model;
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(selected_model.provider_defaults::jsonb -> 'additionalNetwork', '[]'::jsonb)) item
        WHERE item ->> 'modelId' IS NULL OR item ->> 'modelId' NOT IN ('cb8ffe3f3fd54832bbd01885520b23d0', '8802aa18b81f49718df366ce960508db')
    ) THEN
        RAISE EXCEPTION '生成默认参数仍引用将停用的 LoRA，请先检查';
    END IF;
    next_models := jsonb_build_array(retained, existing);
    IF models = next_models THEN
        RAISE NOTICE '模型 % 已仅开放两款裸眼 3D LoRA，无需修改', selected_model.id;
        RETURN;
    END IF;
    IF selected_model.capability_version IS DISTINCT FROM expected_version THEN
        RAISE EXCEPTION '模型能力版本已变化，停止以保护并发修改';
    END IF;
    UPDATE channel_models
    SET capability_config_json = jsonb_set(old_config, '{image,lora,models}', next_models)::text,
        capability_version = capability_version + 1, updated_at = now()
    WHERE id = selected_model.id AND capability_version = expected_version;
    IF NOT FOUND THEN
        RAISE EXCEPTION '模型并发更新，停止';
    END IF;
    RAISE NOTICE '模型 % 现开放两款裸眼 3D LoRA，其余旧项停用，能力版本 % -> %', selected_model.id, expected_version, expected_version + 1;
END
$configure$;

\if :dry_run
  ROLLBACK;
\else
  COMMIT;
\endif
