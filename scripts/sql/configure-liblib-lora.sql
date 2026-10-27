-- PostgreSQL：为现有 Liblib 系统渠道登记已核验底模和 LoRA。
-- 先部署支持 image.lora 的后端；执行前备份数据库。
-- 版本信息已用 POST /api/model/version/get 核验：公开且 commercialUse=1。
-- 元数据可查询不代表所有模型组合的生成质量已验收。
-- F.1 开放官方目录的 11 类 Control Type、13 个模型、40 个预处理器。
-- Redux 缺少已核实的预处理映射，主体参考需要专用流程，本脚本不开放。
-- 官方合同：https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d
-- psql -X -v ON_ERROR_STOP=1 -v dry_run=true -f scripts/sql/configure-liblib-lora.sql
-- 去掉 dry_run 演练参数即可提交。可重复执行；不覆盖已有价格和生成配置。
-- 写入后递增 Redis canvas:logical-model-route-catalog:version。
-- 仅添加渠道模型，不创建/改写前台逻辑模型及线路。
-- 售价沿用现有 Liblib 1 积分/张，单次 1 张，不额外收取 LoRA 费用。

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE liblib_lora_catalog (id text, name text, base_model text, triggers jsonb) ON COMMIT DROP;
INSERT INTO liblib_lora_catalog VALUES
('31360f2f031b4ff6b589412a52713fcf', '筑梦工业 · 海报美学', 'sdxl', '["Movie Poster Style"]'),
('1fe2174f51d04fedb724b28f48d55b7a', 'CJ · 商业扁平插画', 'sdxl', '["Illustration"]'),
('098f08f604ec4c6c9b4ecf9167d39e63', '银河系漫游指南 · 创意陈列', 'sdxl', '["Creative Showcase"]'),
('7ba01e531f424ca3b86b4bf00e3abd10', '电商超现实主义 v2', 'sdxl', '["changjingA"]'),
('de0db8bac1844d078e1782bd01a64f35', '电商万物绘 XL_V1 · 工业产品', 'sdxl', '[]'),
('b50b9cce2147400cb161d9be5d4adb6e', '摸鱼 · 商业写实渲染', 'sdxl', '[]'),
('f1119d1dc33a46b8b460dd29ef6dabd2', '油条 · 商业产品大片 PRO', 'sdxl', '["Realistic product commercial blockbuster"]'),
('bbc080acca124995b3dfbd26e56bb278', '字体 Logo · 材质效果', 'sdxl', '["CZG", "Fluid texture"]'),
('76af914cc3434937aa13aeb038aae838', '618 海报运营启动页', 'f1', '["yun"]'),
('be3909c5d7114d3b8717e966c884d3e1', 'Pure Flux · 情绪插画', 'f1', '["Simple vector illustration"]'),
('b59f7eb734864a74ba476af3aa28c2f3', 'Filmfotos · 日系胶片写真 FLUX', 'f1', '["filmfotos", "film grain", "reversal film photography"]'),
('169505112cee468b95d5e4a5db0e5669', '极氪白白酱 · F.1 人像 V6MAX', 'f1', '["JKBB"]'),
('50284151e507431facc2325cd62f73a3', 'UNIT · F.1 曼德拉效应', 'f1', '[]'),
('b1d4b896d69d408b815b545126a92df0', '嘉嘉 · 国潮插画 F.1', 'f1', '[]'),
('85a2a6bd4dd945a78f6430c9c4911cf0', '风月无边 · 插画 F.1', 'f1', '[]');

CREATE TEMP TABLE liblib_checkpoints (id text, name text, base_model text, purpose text, sort_order int) ON COMMIT DROP;
INSERT INTO liblib_checkpoints VALUES
('0ea388c7eb854be3ba3c6f65aac6bfd3', 'Dream Tech XL', 'sdxl', '通用写实、产品与海报', 0),
('21df5d84cca74f7a885ba672b5a80d19', 'AWPortrait XL 1.1', 'sdxl', '人像摄影', 1),
('bd065cff3a854af2b28659ed0f6d289d', 'niji 动漫二次元 SDXL 2.0', 'sdxl', '动漫与插画', 2),
('d3bfdeba43bc4b5ca44e35d9fcd2f487', '比鲁斯大型建筑 XL0.35_PRO', 'sdxl', '建筑、空间与产品背景', 3),
('0fe4adf217af4c9f9a0d6fda61b3f1cc', '绘梦虚拟3D V2', 'sdxl', '3D 风格产品、盲盒与电商海报', 4),
('412b427ddb674b4dbab9e5abd5ae6057', 'F.1-dev-fp8', 'f1', 'F.1 通用与异形屏生成；支持 F.1 ControlNet 和 LoRA', 5);

DO $configure$
DECLARE
    channel_record model_channels%ROWTYPE;
    source_model channel_models%ROWTYPE;
    target_model channel_models%ROWTYPE;
    tier channel_model_price_tiers%ROWTYPE;
    checkpoint record;
    catalog jsonb;
    capability_profile jsonb;
    defaults jsonb;
    next_value bigint;
    next_id text;
    f1_controlnet constant jsonb := '{
      "supported":true,"maxUnits":4,"baseModel":"f1",
      "preprocessors":["canny","hed","hed_safe","pidinet","pidinet_safe","softedge_teed","softedge_anyline","scribble_pidinet","scribble_xdog","scribble_hed","lineart_realistic","lineart_standard","lineart_coarse","lineart_anime","lineart_anime_denoise","depth_midas","depth_leres","depth_leres++","depth_zoe","depth_hand_refiner","depth_anything","normal_map","normal_bae","mediapipe_face","openpose","openpose_hand","openpose_face","openpose_faceonly","openpose_full","dw_openpose_full","tile_resample","tile_colorfix","tile_colorfix+sharp","blur_gaussian","ip-adapter-siglip","inpaint_global_harmonious","inpaint_only","inpaint_only+lama","none","invert"],
      "models":["017997cd6ba44c4dbe8f60e0a26cd0df","13c1e1b96ba64f9cbb2b54f89b5fe873","6c4d620df3644514903b8189735c6ae9","3e6860a3b9444f25ae07d9c1b5d1ba9e","0cc4e6b8206b44cdab51e30fb8b9c328","64dd7a6c714f4512a4500f6a01b016b7","e51fdccdf3b8417aab246bde40b5f360","7c6d889cb9c04b78858d8fece80f9f85","a696b5bdadc740119fd76505b33d6898","c6ed70879cf011ef96d600163e37ec70","012d2f780c0b44dba829bb223207e608","31df01fc271d484ca4d496179d69a665","405836d1ae2646b4ba2716ed6bd5453a"]
    }'::jsonb;
BEGIN
    SELECT * INTO STRICT channel_record FROM model_channels
      WHERE lower(name)='liblib' AND scope='system' AND deleted_at IS NULL FOR UPDATE;
    IF channel_record.enabled IS DISTINCT FROM true
       OR rtrim(channel_record.base_url, '/') IS DISTINCT FROM 'https://openapi.liblibai.cloud'
       OR coalesce(channel_record.api_key, '')='' OR coalesce(channel_record.secret_key, '')='' THEN
        RAISE EXCEPTION '需要已启用且已配置官方地址及 AK/SK 的 Liblib 系统渠道';
    END IF;
    SELECT * INTO STRICT source_model FROM channel_models
      WHERE channel_id=channel_record.id AND model_key='0ea388c7eb854be3ba3c6f65aac6bfd3' AND deleted_at IS NULL FOR UPDATE;
    IF source_model.protocol IS DISTINCT FROM 'liblib-image' OR source_model.capability IS DISTINCT FROM 'image'
       OR source_model.capability_config_json::jsonb #>> '{image,controlNet,baseModel}' IS DISTINCT FROM 'sdxl'
       OR source_model.capability_config_json::jsonb #>> '{image,maxOutputs}' IS DISTINCT FROM '1'
       OR source_model.provider_defaults::jsonb ->> 'family' IS DISTINCT FROM 'sd' THEN
        RAISE EXCEPTION '现有 Dream Tech XL 配置不符合本次 SDXL 模板来源要求';
    END IF;

    FOR checkpoint IN SELECT * FROM liblib_checkpoints ORDER BY sort_order LOOP
        SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'baseModel',base_model,
            'triggerWords',triggers,'defaultWeight',0.8,
            'sourceUrl','https://resonate.feishu.cn/wiki/UAMVw67NcifQHukf8fpccgS5n6d') ORDER BY name)
          INTO catalog FROM liblib_lora_catalog WHERE base_model=checkpoint.base_model;
        SELECT * INTO target_model FROM channel_models
          WHERE channel_id=channel_record.id AND model_key=checkpoint.id AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
            capability_profile := source_model.capability_config_json::jsonb #- '{image,lora}' #- '{image,parameters}';
            capability_profile := jsonb_set(capability_profile, '{image,resolution}', '{"supported":false,"values":[],"default":"auto"}'::jsonb);
            capability_profile := jsonb_set(capability_profile, '{image,quality}', '{"supported":false,"values":[],"default":"auto"}'::jsonb);
            capability_profile := jsonb_set(capability_profile, '{image,resolutionUsesQuality}', 'false'::jsonb);
            -- 新模型先开放常用 1K 档；不复制来源中的 2K/4K 扩展与自定义尺寸。
            capability_profile := jsonb_set(capability_profile, '{image,size}', '{"parameter":"size","values":["1024x1024","768x1024","1024x768"],"default":"1024x1024","allowCustom":false,"presets":[{"size":"1024x1024","tier":"1k","ratio":"1:1","width":1024,"height":1024},{"size":"768x1024","tier":"1k","ratio":"3:4","width":768,"height":1024},{"size":"1024x768","tier":"1k","ratio":"4:3","width":1024,"height":768}]}'::jsonb);
            defaults := source_model.provider_defaults::jsonb - 'additionalNetwork' - 'checkPointId' - 'templateUuid';
            IF checkpoint.base_model='f1' THEN
                capability_profile := jsonb_set(capability_profile, '{image,controlNet}', f1_controlnet);
                capability_profile := jsonb_set(capability_profile, '{image,references,maskSupported}', 'false'::jsonb);
                defaults := '{"family":"f1","steps":25,"sampler":1,"cfgScale":3.5,"seed":-1,"denoisingStrength":0.75,"textToImageTemplateUuid":"6f7c4652458d4802969f8d089cf5b91f","imageToImageTemplateUuid":"63b72710c9574457ba303d9d9b8df8bd"}'::jsonb;
            END IF;
            INSERT INTO id_sequences(name,value,updated_at) VALUES('id:MODEL',0,now()) ON CONFLICT(name) DO NOTHING;
            UPDATE id_sequences SET value=greatest(value,(SELECT coalesce(max(substring(id FROM '^MODEL_([0-9]+)$')::bigint),0) FROM channel_models))+1,updated_at=now()
              WHERE name='id:MODEL' RETURNING value INTO next_value;
            next_id := 'MODEL_' || lpad(next_value::text,greatest(6,length(next_value::text)),'0');
            INSERT INTO channel_models(id,channel_id,model_key,provider_model_key,display_name,channel_label,tags,description,sort_order,icon,capability,protocol,billing_mode,
                unit_price_microcredits,input_token_price_microcredits,output_token_price_microcredits,cached_token_price_microcredits,price_configured,enabled,price_version,
                capability_config_json,capability_version,provider_defaults,catalog_model_key,created_at,updated_at)
              VALUES(next_id,channel_record.id,checkpoint.id,checkpoint.id,checkpoint.name,'Liblib','[]',checkpoint.purpose,source_model.sort_order+checkpoint.sort_order,'','image','liblib-image','fixed_request',
                1000000,0,0,0,true,true,1,capability_profile::text,1,defaults::text,'',now(),now()) RETURNING * INTO target_model;
        END IF;
        IF target_model.protocol IS DISTINCT FROM 'liblib-image' OR target_model.capability IS DISTINCT FROM 'image'
           OR target_model.provider_model_key IS DISTINCT FROM checkpoint.id
           OR target_model.unit_price_microcredits IS DISTINCT FROM 1000000
           OR target_model.billing_mode IS DISTINCT FROM 'fixed_request'
           OR target_model.enabled IS DISTINCT FROM true OR target_model.price_configured IS DISTINCT FROM true
           OR target_model.capability_config_json::jsonb #>> '{image,maxOutputs}' IS DISTINCT FROM '1' THEN
            RAISE EXCEPTION '已有模型 % 与本次协议/价格/数量要求冲突，停止且不覆盖', checkpoint.name;
        END IF;
        -- 保留已有管理员目录项；本次核验过的相同 UUID 使用最新元数据。
        SELECT jsonb_agg(item ORDER BY item->>'name') INTO catalog FROM (
            SELECT item FROM jsonb_array_elements(coalesce(target_model.capability_config_json::jsonb #> '{image,lora,models}','[]'::jsonb)) item
              WHERE NOT EXISTS(SELECT 1 FROM liblib_lora_catalog known WHERE known.id=item->>'id')
            UNION ALL SELECT item FROM jsonb_array_elements(catalog) item
        ) merged;
        capability_profile := jsonb_set(target_model.capability_config_json::jsonb,'{image,lora}',
            jsonb_build_object('supported',true,'maxNetworks',5,'baseModel',checkpoint.base_model,'models',catalog));
        IF checkpoint.base_model='f1' THEN
            IF target_model.provider_defaults::jsonb ->> 'family' IS DISTINCT FROM 'f1'
               OR capability_profile #>> '{image,controlNet,baseModel}' IS DISTINCT FROM 'f1' THEN
                RAISE EXCEPTION 'F.1 底模与模板配置不一致，停止且不覆盖';
            END IF;
            -- 只升级本脚本旧版留下的关闭配置；已启用的管理员白名单保持不变。
            IF capability_profile #> '{image,controlNet}' = '{"supported":false,"maxUnits":4,"preprocessors":["canny"],"baseModel":"f1"}'::jsonb THEN
                capability_profile := jsonb_set(capability_profile, '{image,controlNet}', f1_controlnet);
            ELSIF capability_profile #>> '{image,controlNet,supported}' IS DISTINCT FROM 'true' THEN
                RAISE EXCEPTION 'F.1 ControlNet 已有自定义关闭配置，请先检查后显式启用';
            END IF;
            UPDATE channel_models SET description=checkpoint.purpose,updated_at=now()
              WHERE id=target_model.id AND description='F.1 通用生成与 F.1 LoRA；不开放 SDXL ControlNet';
        END IF;
        UPDATE channel_models SET capability_config_json=capability_profile::text,capability_version=capability_version+1,updated_at=now()
          WHERE id=target_model.id AND capability_config_json::jsonb IS DISTINCT FROM capability_profile;

        SELECT * INTO tier FROM channel_model_price_tiers
          WHERE channel_model_id=target_model.id AND selector_key='{}' AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
            INSERT INTO id_sequences(name,value,updated_at) VALUES('id:PTIER',0,now()) ON CONFLICT(name) DO NOTHING;
            UPDATE id_sequences SET value=greatest(value,(SELECT coalesce(max(substring(id FROM '^PTIER_([0-9]+)$')::bigint),0) FROM channel_model_price_tiers))+1,updated_at=now()
              WHERE name='id:PTIER' RETURNING value INTO next_value;
            next_id := 'PTIER_' || lpad(next_value::text,greatest(6,length(next_value::text)),'0');
            INSERT INTO channel_model_price_tiers(id,channel_model_id,selector_key,selector_json,resolution,video_seconds,provider_model_key,billing_mode,
                unit_price_microcredits,input_token_price_microcredits,output_token_price_microcredits,cached_token_price_microcredits,price_configured,enabled,price_version,created_at,updated_at)
              VALUES(next_id,target_model.id,'{}','{}','*',0,checkpoint.id,'fixed_request',1000000,0,0,0,true,true,1,now(),now()) RETURNING * INTO tier;
        END IF;
        IF tier.enabled IS DISTINCT FROM true OR tier.price_configured IS DISTINCT FROM true
           OR tier.unit_price_microcredits IS DISTINCT FROM 1000000 OR tier.billing_mode IS DISTINCT FROM 'fixed_request'
           OR tier.provider_model_key IS DISTINCT FROM checkpoint.id THEN
            RAISE EXCEPTION '已有价格档 % 不符合 1 积分/张配置，停止且不覆盖', tier.id;
        END IF;
        RAISE NOTICE '% [%]：% 个兼容 LoRA，1 积分/张', checkpoint.name,target_model.id,jsonb_array_length(catalog);
    END LOOP;
    UPDATE model_channels SET models_json=(SELECT json_agg(model_key ORDER BY sort_order,id)::text FROM channel_models
        WHERE channel_id=channel_record.id AND deleted_at IS NULL AND enabled),updated_at=now() WHERE id=channel_record.id;
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
