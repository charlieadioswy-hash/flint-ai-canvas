import dramaStyleCatalog from "../../../../backend/internal/app/drama_style_catalog.json";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { DRAMA_STYLE_REFERENCES, type DramaStyleReference } from "./drama-style-references";
import legacyStylePromptDigests from "./legacy-style-prompt-digests.json";
import { composeDramaStyleId, DEFAULT_DRAMA_STYLE_ID, findComposedDramaStyle, parseDramaStyleId, type DramaStyleComposition, type DramaStyleFormId, type DramaStyleThemeId } from "./style-composition";

export { composeDramaStyleId, DEFAULT_DRAMA_STYLE_ID, DRAMA_STYLE_FORMS, DRAMA_STYLE_THEMES, parseDramaStyleId, type DramaStyleComposition, type DramaStyleFormId, type DramaStyleThemeId } from "./style-composition";

// 风格描述长期稳定的美术基线，画幅、构图与动作由作品设置和分镜决定。

export type DramaStyleCategory = "live" | "3d" | "2d" | "art";

export type DramaStyle = {
    id: string;
    name: string;
    category: DramaStyleCategory;
    hot?: boolean;
    tags: string[];
    aliases?: string[];
    description: string;
    cover?: string;
    sampleImages?: string[];
    palette: [string, string, string];
    prompt: string;
    /** 拆开的美术基线，供详情弹窗分项展示；prompt 由这些字段拼成。 */
    detail: { medium: string; world: string; look: string; wardrobe: string; forbid: string };
};

type Spec = Omit<DramaStyle, "prompt" | "detail"> & { medium?: string; world: string; look: string; wardrobe: string; forbid?: string };

export const DRAMA_STYLE_CATEGORIES: Array<{ key: "all" | "hot" | DramaStyleCategory; label: string }> = [
    { key: "hot", label: "爆款" },
    { key: "all", label: "全部" },
    { key: "live", label: "真人短剧" },
    { key: "3d", label: "3D 动画" },
    { key: "2d", label: "2D 漫剧" },
    { key: "art", label: "艺术风格" },
];

const MEDIUM: Record<DramaStyleCategory, string> = {
    live: "真人实拍短剧质感，电影级布光，真实皮肤纹理与毛孔，自然景深，人物面部清晰可读、表情自然生动",
    "3d": "高品质 3D 动画渲染，建模精致，材质与光照物理可信，角色表情生动",
    "2d": "高品质 2D 动画漫剧，线稿清晰流畅，上色干净，角色五官稳定",
    art: "具有鲜明艺术语言的风格化画面，全剧统一笔触与材质",
};

const FORBID: Record<DramaStyleCategory, string> = {
    live: "动漫化、塑料皮肤、过度磨皮、畸形手指、文字水印",
    "3d": "模型穿插、贴图拉伸、同一物件材质跳变、文字水印",
    "2d": "3D 渲染感、真人照片质感、崩坏五官、文字水印",
    art: "风格混杂、畸形手指、文字水印",
};

const cover = (name: string) => `/short-drama-styles/${name}.jpg`;
const sampleImages = (id: string) => [1, 2, 3].map((index) => cover(`${id}-${index}`));

const SPECS: Spec[] = [
    // ===== 真人短剧 =====
    {
        id: "live-ceo",
        name: "都市霸总",
        category: "live",
        hot: true,
        tags: ["总裁", "豪门", "虐恋"],
        description: "冷调高级写字楼与豪宅，强轮廓光，气场压迫。",
        cover: cover("urban-live-action"),
        palette: ["#0f172a", "#334155", "#c8a96a"],
        medium: "真人都市电影摄影，冷灰蓝基底与香槟金边光，硬朗线条和干净的镜面反射",
        world: "沿用剧本空间，用建筑纵深、垂直线条和深浅材质组织层次",
        look: "高反差侧光突出轮廓，暖金限于局部反射，脸部暗面仍有细节",
        wardrobe: "按人物身份与场合选择服装，精纺织物、皮革和金属保留各自的光泽",
        forbid: "全画面暖金染色、玻璃过曝、通篇豪宅化",
    },
    {
        id: "live-sweet",
        name: "甜宠恋爱",
        category: "live",
        hot: true,
        tags: ["甜宠", "心动", "都市"],
        description: "奶油蜜桃色，柔光逆光，满屏心动。",
        cover: cover("sweet-romance"),
        palette: ["#fde2e4", "#f7a1b5", "#fff1e6"],
        medium: "真人轻暖影像，奶油白配淡蜜桃高光，柔和逆光与透明肤色",
        world: "沿用剧本空间，利用自然景深将人物与环境轻柔分开",
        look: "顺着现有光源使用发丝边光和轻微高光扩散，白色与肤色保持自然",
        wardrobe: "服装遵循身份与场合，棉布针织等柔软材质保留细部",
        forbid: "粉色通铺、浓重柔焦、装饰性爱心光斑",
    },
    {
        id: "live-flash",
        name: "闪婚先婚后爱",
        category: "live",
        hot: true,
        tags: ["闪婚", "契约", "甜虐"],
        description: "民政局、婚房与家宴，暖金色调的婚恋剧。",
        sampleImages: sampleImages("live-flash"),
        palette: ["#3f2a1d", "#c08457", "#fbe7c6"],
        medium: "真人情感剧情片，蜜棕与象牙白相衬，暖金柔光收住高光",
        world: "按剧本配置生活或公共空间，保留可辨的背景纹理与距离",
        look: "室内由暖白实景灯或窗光过渡到蜜棕阴影，室外随时段调节明暗，近景保持自然肤色",
        wardrobe: "服装随身份和场合变化，米白缎面与细木纹只在素材已有时发挥质感",
        forbid: "婚纱摄影棚光、过度金色偏色、背景完全虚化",
    },
    {
        id: "live-heiress",
        name: "真假千金",
        category: "live",
        hot: true,
        tags: ["豪门", "身世", "打脸"],
        description: "豪门宴会与家族冲突，华丽高对比。",
        sampleImages: sampleImages("live-heiress"),
        palette: ["#1f1023", "#9d174d", "#f5d0a9"],
        medium: "真人高对比剧情片，深酒红与香槟色对照，丝绒与玻璃各有反射层次",
        world: "环境等级与陈设根据剧本，用材质反差营造华丽而清晰的空间层次",
        look: "暖香槟高光衬冷暗部，侧光边界清楚，晶体和金属只在光源位置形成亮点",
        wardrobe: "人物身份与着装按剧本，织物光泽、剪裁和配饰密度随场合变化",
        forbid: "酒红泛光覆盖肤色、强制贵重配饰、奢华陈设挤满画面",
    },
    {
        id: "live-rebirth",
        name: "重生复仇",
        category: "live",
        hot: true,
        tags: ["重生", "复仇", "爽剧"],
        description: "冷暖强反差，情绪大特写，节奏感强。",
        sampleImages: sampleImages("live-rebirth"),
        palette: ["#111827", "#7f1d1d", "#f59e0b"],
        medium: "真人高反差电影摄影，冷青阴影切入暖橙局部主光，面部层次分明",
        world: "用已有门窗、墙面和前景反光组织冷暖区域，时间与地域服从剧本",
        look: "让冷暖来自可追溯的光源，局部橙光压住高光，暗处保留眼神与轮廓",
        wardrobe: "服装按人物设定与出场阶段取舍，明暗材质反应随实际照明",
        forbid: "按角色善恶染色、肤色过橙、青橙高饱和通铺",
    },
    {
        id: "live-warlord",
        name: "战神赘婿",
        category: "live",
        hot: true,
        tags: ["战神", "赘婿", "打脸"],
        description: "低饱和硬朗色调，硬光强对比，气势张扬。",
        sampleImages: sampleImages("live-warlord"),
        palette: ["#1c1917", "#57534e", "#b45309"],
        medium: "真人硬朗电影摄影，低饱和褐灰和铜橙硬光，深阴影保留材质",
        world: "用剧本已有空间里的梁柱与门洞形成硬朗纵深，强调物体重量感",
        look: "有来源的顶光和斜侧光切出块面，铜色仅落在局部暖反射与轮廓",
        wardrobe: "保留造型设定中的面料厚薄与真实磨损，服装等级按身份和环境决定",
        forbid: "每场固定制服或黑风衣、机械套用仰拍和慢动作、无来源的浓烟",
    },
    {
        id: "live-doctor",
        name: "神医下山",
        category: "live",
        tags: ["神医", "都市", "逆袭"],
        description: "都市与山林交错，银针药香的奇人爽剧。",
        sampleImages: sampleImages("live-doctor"),
        palette: ["#14261c", "#4d7c5a", "#e8dcc0"],
        medium: "真人写实摄影，草木青绿与柔暖米黄相衬，真实木石和织物层次",
        world: "沿用剧本指定的自然或城市环境，用表面质地和景深连接空间",
        look: "自然环境用青绿漫射与米色暖光，城市环境用清冷中性光，雾气随天气出现",
        wardrobe: "依人物身份保留服装与道具，棉麻、皮革和金属呈自然质感",
        forbid: "无设定的针具或药箱、过度柔焦、绿光染肤",
    },
    {
        id: "live-baby",
        name: "萌宝助攻",
        category: "live",
        tags: ["萌宝", "带娃", "甜宠"],
        description: "明亮温馨的家庭色调，萌娃视角。",
        sampleImages: sampleImages("live-baby"),
        palette: ["#fff7ed", "#fdba74", "#93c5fd"],
        medium: "真人日常影像，明亮暖白配浅橙与淡蓝，软光和真实木色",
        world: "空间和人物关系以剧本为准，儿童视角出现时保留可信的桌椅和门窗尺度",
        look: "大面积柔光过渡平缓，浅橙和淡蓝小面积点缀，亮部依然可辨",
        wardrobe: "按年龄、动作和场合选择自然织物与合身造型，保留生活痕迹",
        forbid: "全画面玩具化或粉彩化、童装棚拍、无需要的低机位",
    },
    {
        id: "live-palace",
        name: "古装宫廷",
        category: "live",
        hot: true,
        tags: ["宫斗", "权谋", "后宫"],
        description: "金红宫墙与锦缎华服，烛光暖调，庄重华丽。",
        cover: cover("palace-hanfu"),
        palette: ["#5b1a18", "#a3332b", "#d9a441"],
        medium: "真人古装摄影，朱红、暗金与墨绿，织锦和漆木带细腻的烛光反射",
        world: "场景尺度和礼制依时代与身份，庄重仪式可用建筑轴线和对称留白",
        look: "暖灯照亮朱红和金纹细节，天光保持冷暖层次，人物暗部清楚",
        wardrobe: "按朝代和场合选择衣料、冠饰与妆发，礼服织纹和光泽对应真实材质",
        forbid: "礼服套用日常人物、跨朝代装饰、红金泛光压没肤色",
    },
    {
        id: "live-xianxia",
        name: "古装仙侠",
        category: "live",
        hot: true,
        tags: ["修仙", "玄幻", "虐恋"],
        description: "云海仙山、飘逸纱衣与克制的法术光效。",
        sampleImages: sampleImages("live-xianxia"),
        palette: ["#0e2a3b", "#5b8fa8", "#e6f0f2"],
        medium: "真人仙侠摄影，清透青白与天蓝，薄雾、纱层和自然冷光分出纵深",
        world: "沿用剧本空间和设定，云雾、术法及悬空结构只在情节需要时出现",
        look: "体积光随空间和光源变化，已有术法用少量反射与粒子从暗处显出",
        wardrobe: "依身份与活动配置衣冠，纱、绸和玉饰体现透明度、厚度与重量差异",
        forbid: "游戏式泛光、全景法术粒子、纱层和肤色过曝",
    },
    {
        id: "live-wuxia",
        name: "武侠江湖",
        category: "live",
        tags: ["武侠", "江湖", "快意"],
        description: "大漠客栈竹林，刀光剑影的写实武侠。",
        cover: cover("wuxia-swordsman"),
        palette: ["#2b2116", "#8a6a3f", "#d9c4a0"],
        medium: "真人武侠电影摄影，赭黄尘土配墨绿阴影，布、木、石和旧金属质地粗粝",
        world: "空间和动作以剧本为准，用自然遮挡、真实地表和明确站位建立纵深",
        look: "自然侧逆光勾出衣料和轮廓，晴燥环境允许薄尘，暗处保留细节",
        wardrobe: "衣装、行具与兵器按既有设定，粗布和磨旧皮革保留使用痕迹",
        forbid: "无设定依据的兵器、脱离镜头设计的定格、无来源扬尘、魔法彩光铺屏",
    },
    {
        id: "live-farm",
        name: "穿越种田",
        category: "live",
        tags: ["穿越", "种田", "家长里短"],
        description: "古代乡村与田园，温暖治愈的生活流。",
        sampleImages: sampleImages("live-farm"),
        palette: ["#2f3a1f", "#8aa35a", "#f2e2b3"],
        medium: "真人田园生活片，麦黄与嫩绿叠映，旧木、陶土和麻布保留手作质感",
        world: "年代、农时与地形依剧本，用真实使用痕迹描绘生活空间",
        look: "暖色日照与自然阴影间保持柔和过渡，室内光随现有门窗和灯火变化",
        wardrobe: "衣着和器物服从地域、年代与身份，按实际活动表现磨损和褶皱",
        forbid: "农具反复摆拍、年代穿帮、全画面橙黄滤镜",
    },
    {
        id: "live-republic",
        name: "民国谍战",
        category: "live",
        tags: ["民国", "谍战", "年代"],
        description: "复古褪色胶片、旗袍长衫、老上海。",
        cover: cover("black-white-noir"),
        palette: ["#2b2118", "#7c5c3b", "#c9a46b"],
        medium: "真人民国电影摄影，褪色暖棕与煤灰、细胶片颗粒、柔化高光",
        world: "年代、地域和建筑密度遵循剧本，木窗、砖墙等已有构件形成近远层次",
        look: "窄侧窗光和实景灯形成局部暖棕亮面，暗处仍看得清人物和空间结构",
        wardrobe: "按年份、地域和身份选择剪裁、面料和配件，保留旧革与木漆细节",
        forbid: "年代穿帮、一律旗袍礼帽、过重茶褐滤镜、强制黑夜",
    },
    {
        id: "live-era",
        name: "年代怀旧",
        category: "live",
        tags: ["八零", "知青", "家庭"],
        description: "七八十年代小城与大院，暖黄怀旧滤色。",
        cover: cover("era-nostalgia"),
        palette: ["#3f3a2e", "#8a7a52", "#e2c98d"],
        world: "家属大院、筒子楼、供销社、田间与小城街道",
        look: "暖黄偏绿的怀旧色调，柔和自然光，轻微胶片颗粒",
        wardrobe: "的确良衬衫、军绿外套、碎花布衣",
        forbid: "现代物件",
    },
    {
        id: "live-suspense",
        name: "悬疑刑侦",
        category: "live",
        hot: true,
        tags: ["悬疑", "刑侦", "反转"],
        description: "冷青低调光，雨夜与霓虹，压迫感构图。",
        cover: cover("suspense-noir"),
        palette: ["#0b1215", "#1f3a40", "#5eead4"],
        medium: "真人刑侦电影摄影，冷青灰和可辨硬光，前景遮挡形成窥视感",
        world: "沿用剧本地理与场景，用已有门窗、栏杆等边缘形成遮挡和层次",
        look: "可见主光压住大面积暗部，眼神与线索处保留细节，湿地反射随天气",
        wardrobe: "服装、制服和道具按现有人物设定，织物表面呈低调哑光",
        forbid: "强制警服、遍地水光、阴影纯黑压没线索、诡异绿雾",
    },
    {
        id: "live-horror",
        name: "灵异惊悚",
        category: "live",
        tags: ["灵异", "惊悚", "民俗"],
        description: "幽绿冷光与浓雾，中式民俗恐怖。",
        sampleImages: sampleImages("live-horror"),
        palette: ["#050a08", "#1d3b2f", "#9ca3af"],
        medium: "真人惊悚电影摄影，幽绿与近黑压低亮度，旧木、褪色织物和薄雾分层",
        world: "场所和民俗符号以剧本为准，可借已有物件的遮挡与负空间营造异样感",
        look: "小范围斜光或低位反光显出轮廓，雾只在环境成立时衰减远处细节",
        wardrobe: "依角色和地域配服装道具，纸、纱、木料保留粗细和透光差别",
        forbid: "无剧情依据的纸扎、阴影压黑全部主体、用血腥特写替代氛围",
    },
    {
        id: "live-apocalypse",
        name: "末世囤货",
        category: "live",
        tags: ["末世", "丧尸", "系统"],
        description: "灰黄废墟、尘埃体积光、粗粝写实。",
        sampleImages: sampleImages("live-apocalypse"),
        palette: ["#2a2620", "#6b5d45", "#c2a36b"],
        world: "坍塌城市、废弃商场、临时营地、地下仓库",
        look: "灰黄褪色主色，尘埃与烟雾中的体积光，粗粝材质与污渍",
        wardrobe: "破损实用的户外装备、改装武器与物资",
    },
    {
        id: "live-campus",
        name: "校园青春",
        category: "live",
        tags: ["校园", "初恋", "成长"],
        description: "通透日光，青绿清新，胶片柔焦。",
        sampleImages: sampleImages("live-campus"),
        palette: ["#e0f2fe", "#86efac", "#fde68a"],
        medium: "真人青春片摄影，晴透青绿与浅黄日色，细胶片颗粒和轻柔高光",
        world: "沿用剧本场所和季节，明净日常空间留出自然纵深和人物动线",
        look: "开放天光和柔和反射，阴影可稍带浅青，日落或室内仍保持空间真实",
        wardrobe: "服装随年龄、身份和活动，衣领、面料与动作褶皱自然",
        forbid: "擅自统一人物年龄或服装、强烈商业棚光、通篇绿色滤镜",
    },
    {
        id: "live-workplace",
        name: "职场逆袭",
        category: "live",
        tags: ["职场", "大女主", "商战"],
        description: "现代办公冷白光，利落干练的商战质感。",
        sampleImages: sampleImages("live-workplace"),
        palette: ["#0f1720", "#475569", "#e2e8f0"],
        medium: "真人职场摄影，冷白与石墨灰配清晰几何线条，表面偏哑光",
        world: "依据剧本选择工作环境，用已有框架和干净的背景分离主体",
        look: "干净中性的顶光或侧窗漫射，玻璃与金属只保留有限冷亮反射",
        wardrobe: "服装随岗位和场合取舍，利落剪裁和低调面料保留细节",
        forbid: "强制西装、冷光染蓝肤色、每场固定对峙正反打",
    },
    {
        id: "live-hk",
        name: "港风复古",
        category: "live",
        tags: ["港风", "九十年代", "江湖"],
        description: "港片霓虹，暖红胶片与高颗粒。",
        cover: cover("retro-hong-kong"),
        palette: ["#2a0f12", "#b91c1c", "#facc15"],
        world: "霓虹街道、茶餐厅、旧式公寓、码头",
        look: "暖红与霓虹绿交织，明显胶片颗粒与轻微晕光，夜景为主",
        wardrobe: "垫肩西装、花衬衫、复古连衣裙",
    },
    {
        id: "live-cyber",
        name: "赛博朋克",
        category: "live",
        tags: ["赛博", "未来", "霓虹"],
        description: "雨夜霓虹都市，青紫撞色与全息光。",
        cover: cover("cyberpunk-neon"),
        palette: ["#0b0620", "#7c3aed", "#22d3ee"],
        medium: "真人赛博摄影，深靛蓝暗面由品红与电青光分区，表面反射有层次",
        world: "保留剧本中的城市尺度与科技水平，机械结构和显示光源只在设定支持时出现",
        look: "霓虹限于可见或可信的光源，沿潮湿度与粗糙度产生反光，暗面保留轮廓",
        wardrobe: "机能织物或义体按角色设定，哑光布料、金属与灯带有真实材质差异",
        forbid: "雨夜和义体套用每场、青紫覆盖整张脸、额外悬浮 UI",
    },
    {
        id: "live-scifi",
        name: "星际科幻",
        category: "live",
        tags: ["星际", "太空", "硬科幻"],
        description: "冷白舱体与深空，硬科幻工业质感。",
        cover: cover("space-opera"),
        palette: ["#020617", "#1e3a8a", "#e2e8f0"],
        medium: "真人硬科幻摄影，冷白工业表面与深空蓝暗区，结构接缝和比例可信",
        world: "按剧本保留科技等级与空间规模，舱体或外部环境用尺度参照和可辨结构建立纵深",
        look: "冷白面光交代结构，设备亮度有边界，室外光随设定中的距离和光源变化",
        wardrobe: "按工作环境与角色设定选择装备，金属、复合材料和织物各有反射",
        forbid: "无剧情依据的宇航服、任意巨型屏幕、廉价彩光与镜面塑料",
    },
    {
        id: "live-food",
        name: "美食治愈",
        category: "live",
        tags: ["美食", "小店", "温情"],
        description: "暖橙烟火气，食物特写诱人。",
        cover: cover("food-healing"),
        palette: ["#3b1d0e", "#ea580c", "#fde7c7"],
        medium: "真人暖橙生活摄影，柔暖逆光表现食材、蒸汽和陶木的自然表面",
        world: "人物和场所由剧本决定，食材与餐具出现时保留真实比例和接触关系",
        look: "暖光落在食材与手作质地上，蒸汽随温度存在，近摄用于有意义的食物细节",
        wardrobe: "服装和工作装备按角色活动，保留织物与器皿的自然使用痕迹",
        forbid: "所有镜头食物特写、无来源蒸汽、食材橙黄过饱和",
    },
    {
        id: "live-rural",
        name: "乡村振兴",
        category: "live",
        tags: ["乡村", "返乡", "创业"],
        description: "青山绿水与新农村，明亮正向。",
        cover: cover("rural-life"),
        palette: ["#1f3b2a", "#4ade80", "#fef9c3"],
        medium: "真人当代乡野摄影，青绿与明黄的清亮自然光，地貌和植被层次可辨",
        world: "地域、农时和现代设施按剧本，生活空间与土地用途保持可信",
        look: "晴天清透，阴天保留新鲜灰绿，远近亮度随天气和地势变化",
        wardrobe: "按人物活动和季节搭配服饰，工作织物、器材与地表保留自然使用痕迹",
        forbid: "全景景区宣传片化、强制航拍或晴天、荧光绿色",
    },
    {
        id: "live-tearjerker",
        name: "虐恋催泪",
        category: "live",
        hot: true,
        tags: ["虐恋", "追妻", "催泪"],
        description: "雨夜、医院与离别车站，冷调低饱和，情绪特写。",
        cover: cover("tearjerker"),
        palette: ["#1e293b", "#64748b", "#cbd5e1"],
        medium: "真人情感电影摄影，低饱和冷灰蓝与宽柔侧光，面部明暗过渡细腻",
        world: "沿用剧本时空，通过视线、间距与留白保持人物关系可读",
        look: "低反差柔光保住眼神与肤色，窗上雨痕或虚化灯点仅随真实环境出现",
        wardrobe: "人物服装和身体状态随剧情，素色织物有自然褶皱和细纹",
        forbid: "强制泪痕、疲态或雨夜、统一灰蓝染肤、每幕重度虚化",
    },
    {
        id: "live-neo-chinese",
        name: "新中式都市",
        category: "live",
        tags: ["新中式", "非遗", "国潮"],
        description: "茶室、园林与现代空间结合，雅致温润。",
        cover: cover("neo-chinese"),
        palette: ["#2b2118", "#8a6a4b", "#e9dcc6"],
        medium: "真人新中式审美，暖木、米白和墨色留白，窗侧自然光呈现哑光纹理",
        world: "现代空间格局由剧本决定，利用现有格栅、墙面和疏密关系组织画面",
        look: "柔和窗光把斑驳光影落在木石和织物上，背景亮部干净而有细节",
        wardrobe: "按设定选择剪裁和配饰，丝、棉麻与木器保留各自的粗糙度",
        forbid: "强制旗袍或茶具、符号堆叠、偏黄滤镜同化全部材质",
    },
    {
        id: "live-family",
        name: "现实家庭",
        category: "live",
        tags: ["家庭", "婆媳", "现实"],
        description: "老小区、菜市场与饭桌，真实生活质感。",
        sampleImages: sampleImages("live-family"),
        palette: ["#3f3f46", "#a8a29e", "#fde68a"],
        medium: "真人生活纪实摄影，中性灰和克制暖黄，保留真实肤质与日常材质",
        world: "地点、年代和生活水平遵循剧本，已有环境保留适量使用痕迹",
        look: "窗光和实景灯依空间自然混合，日夜冷暖可变，照明不刻意美化人物",
        wardrobe: "服装与妆发依人物和活动，布料与物件的质地、清洁度和磨损相符",
        forbid: "附加家庭成员或旧社区、过度棚拍精修、所有空间统一凌乱",
    },
    {
        id: "live-western-fantasy",
        name: "西幻史诗",
        category: "live",
        tags: ["西幻", "王国", "骑士"],
        description: "古堡、雾林与王座厅，史诗级奇幻实拍。",
        cover: cover("fantasy-3d"),
        palette: ["#1c1917", "#57534e", "#d6b97b"],
        world: "中世纪古堡、王座大厅、迷雾森林、山巅要塞",
        look: "体积光穿过薄雾，暖金烛光对比冷蓝夜色，史诗广角与人物近景交替",
        wardrobe: "铠甲、披风、宫廷礼服与皮革装束，细节做旧",
    },

    // ===== 3D 动画 =====
    {
        id: "3d-guoman",
        name: "3D 国漫仙侠",
        category: "3d",
        hot: true,
        tags: ["修仙", "玄幻", "国漫"],
        description: "国产 3D 动画 CG，精致建模与华丽法术光效。",
        sampleImages: sampleImages("3d-guoman"),
        palette: ["#0c1e2e", "#2c6e8f", "#f0c674"],
        medium: "高品质国产 3D 动画 CG 渲染，次世代建模，角色面部精致、保持东方审美，皮肤与布料有次表面散射",
        world: "云海仙山、宗门殿宇、秘境古林",
        look: "冷青与金色主色，体积光与粒子法术光效华丽但不过曝",
        wardrobe: "多层飘逸古装与精致发冠",
    },
    {
        id: "3d-xuanhuan",
        name: "3D 玄幻热血",
        category: "3d",
        hot: true,
        tags: ["玄幻", "热血", "升级"],
        description: "斗气与魂力爆发，高燃战斗特效。",
        sampleImages: sampleImages("3d-xuanhuan"),
        palette: ["#140c2b", "#7c3aed", "#fb923c"],
        medium: "高对比三维玄幻动画，硬质岩石与金属护具对照厚织物，清楚区分暗紫底色和熔橙能量",
        world: "宗门、遗迹、山谷或其他场景随剧本设置，以清楚的地形、尺度和遮挡关系承托行动",
        look: "静场用有层次的暗紫与局部暖光塑形，战斗才加入有源头和方向的橙色冲击波，推拉节奏服从分镜",
        wardrobe: "布袍、护具、灵兽与法器按角色身份和剧情出现，保持甲片结构、磨损与识别轮廓",
        forbid: "日常镜头无故起火、全屏爆光盖住脸和手、凭空添加灵兽或武装",
    },
    {
        id: "3d-myth",
        name: "3D 东方神话",
        category: "3d",
        tags: ["神话", "封神", "国潮"],
        description: "神魔史诗，金红祥云与宏大场面。",
        sampleImages: sampleImages("3d-myth"),
        palette: ["#3b0a0a", "#b91c1c", "#facc15"],
        medium: "金红设色的东方神话三维动画，以赭朱漆面、鎏金浮雕和层叠云纹建立典礼的庄重感",
        world: "按剧本设置水域、宫阙、山林或凡间，用门柱、台阶和远近比例表现神话空间的尺度",
        look: "以朱红、熟金与深青分层，只有神迹或显灵时启用金色逆光和云气边缘，常态保留材质和五官",
        wardrobe: "按身份选用礼袍、羽冠、甲胄或朴素便装，神兽和法器由剧情与资产设定决定",
        forbid: "全景金光过曝、每人配神将铠甲、每处建筑堆满祥云或神兽",
    },
    {
        id: "3d-cg-real",
        name: "3D 写实 CG",
        category: "3d",
        tags: ["写实", "史诗", "动作"],
        description: "接近 3A 游戏过场的电影级写实 CG。",
        cover: cover("cg-realistic"),
        palette: ["#111111", "#3f3f46", "#a1a1aa"],
        medium: "电影级写实 3D CG，接近 3A 游戏过场动画，物理正确的光照与材质，毛发与布料细节丰富",
        world: "根据剧情的写实场景",
        look: "电影化色彩分级，景深与动态模糊自然",
        wardrobe: "写实比例的人物与服装",
    },
    {
        id: "3d-pixar",
        name: "皮克斯动画",
        category: "3d",
        hot: true,
        tags: ["合家欢", "喜剧", "治愈"],
        description: "圆润可爱的美式 3D 动画，明亮温暖。",
        cover: cover("three-d-cartoon"),
        palette: ["#fff7ed", "#fb923c", "#38bdf8"],
        medium: "美式 3D 动画电影风格，角色大眼圆润、头身比可爱夸张，材质柔软光滑",
        world: "富有童趣细节的城镇与家庭场景",
        look: "明亮高饱和暖色调，柔和全局光与轮廓光",
        wardrobe: "简洁可爱的卡通服装",
        forbid: "写实恐怖、阴暗血腥",
    },
    {
        id: "3d-chibi",
        name: "3D Q 版",
        category: "3d",
        tags: ["Q 版", "萌系", "搞笑"],
        description: "二三头身萌系角色，糖果色玩具质感。",
        cover: cover("chibi-3d"),
        palette: ["#fdf2f8", "#f9a8d4", "#a5f3fc"],
        medium: "二至三头身的三维软胶 Q 版，圆头短肢、丰满边缘和柔面反光，表情夸张时仍保留各自脸型",
        world: "依剧本搭建场景，家具、交通与日用品用圆角大形体简化，位置和体量保持一致",
        look: "奶油色垫底，糖果粉、柠檬黄或薄荷绿作为主辅色，柔光保留体积，不让背景争抢焦点",
        wardrobe: "用少量大色块和一两处标志性配件区分角色，版型与身份跟随剧本",
        forbid: "写实头身比、玻璃般的锐利高光、繁复的小配件遮住主体轮廓",
    },
    {
        id: "3d-clay",
        name: "黏土定格",
        category: "3d",
        tags: ["黏土", "定格", "手作"],
        description: "手捏黏土质感与定格的微小顿挫。",
        cover: cover("clay-stop-motion"),
        palette: ["#fef3c7", "#d97706", "#65a30d"],
        medium: "手捏黏土定格动画，角色和道具保留指腹压痕、拼合缝与略不规整的哑光边缘",
        world: "把剧本环境做成微缩布景，用可见的木纹、纸板纤维和塑形细节保留搭建尺度",
        look: "静帧用暖色软光和低反光材质塑形，只有剧情镜头依分镜采用微缩浅景深与克制的步进式动作",
        wardrobe: "将衣领和布褶压成清楚的黏土造型，以编织压纹或窄缝区分织物和道具",
        forbid: "无缝的亮塑料表面、按毛孔处理角色泥面、用跳帧或重影破坏静止设定图",
    },
    {
        id: "3d-toon",
        name: "3D 二次元",
        category: "3d",
        tags: ["二次元", "三渲二", "校园"],
        description: "三渲二卡通着色，日系动画观感。",
        sampleImages: sampleImages("3d-toon"),
        palette: ["#1e1b4b", "#818cf8", "#fbcfe8"],
        medium: "三维模型的赛璐珞着色，人物用两至三阶硬边阴影和可辨细描边，换视角时保持模型体积、接触阴影和透视",
        world: "校园、街区或奇幻环境随剧本设置，近中远景的遮挡和地面联系清楚，镜头运动服从分镜",
        look: "局部使用明亮跳色和克制边光，色阶变化沿光向切分，皮肤、头发与衣料的明暗均可读",
        wardrobe: "按角色身份选服装，用简洁裁片和大色块分出衣物层次，多角度保持花纹位置",
        forbid: "写实毛孔与蜡质皮肤、全画面软渐变吞没硬色阶、跨视角轮廓和材质变化",
    },
    {
        id: "3d-pet",
        name: "萌宠拟人",
        category: "3d",
        tags: ["萌宠", "拟人", "搞笑"],
        description: "毛茸茸的动物主角，表情丰富。",
        cover: cover("pet-3d"),
        palette: ["#fef6e4", "#f4a261", "#8ecae6"],
        medium: "以蓬松毛束、圆润体块和可读表情构成三维动物动画，拟人动物保留所属物种的耳、吻和足爪特征",
        world: "依剧本设置街区、家居或自然场景，用门窗、桌椅或生活用品说明角色和环境的体量关系",
        look: "暖白散射光与柔和逆光区分毛束和背景，毛发按身体部位渐变粗细和方向，面部表情保持清楚",
        wardrobe: "拟人动物出现时按设定添加简洁衣物或配饰，普通角色、物种和身份以剧本及参考素材为准",
        forbid: "把所有角色都动物化、给动物拼接写实人脸、结块油亮的毛发、血腥伤害",
    },
    {
        id: "3d-mecha",
        name: "3D 机甲科幻",
        category: "3d",
        tags: ["机甲", "科幻", "战斗"],
        description: "硬表面机甲与金属反射，工业感。",
        sampleImages: sampleImages("3d-mecha"),
        palette: ["#0b1120", "#475569", "#38bdf8"],
        medium: "三维机械硬表面渲染，以倒角钢板、紧固件、液压关节和接触磨损交代结构与重量",
        world: "只有剧本需要时加入机甲、机库或太空设施，用检修台、栏杆或人员建立可读尺度",
        look: "冷钢灰划分拉丝金属、哑光密封件和油污，电蓝光限于信号、动力源和相应局部反射",
        wardrobe: "操作员衣物与设备涂装按角色和任务区分，接口、分区及磨损位置保持连续",
        forbid: "全身镜面高光、无功能的装甲拼接、推进器遮住主体、自动把人物穿成机甲驾驶员",
    },
    {
        id: "3d-wuxia-game",
        name: "3D 武侠游戏风",
        category: "3d",
        tags: ["武侠", "江湖", "游戏感"],
        description: "次世代游戏 CG 质感的江湖，衣袂翻飞。",
        sampleImages: sampleImages("3d-wuxia-game"),
        palette: ["#111827", "#7f1d1d", "#f5d0a9"],
        medium: "具实体材质的武侠游戏过场三维渲染，细发丝、发束、粗布与擦痕金属清晰，远景有水墨层次",
        world: "依剧本搭建山门、驿道、城镇或室内，以道路、门槛和断层交代可行动空间",
        look: "让夕照、月光或实景灯火清楚塑出衣袂和石木，打斗时依分镜使用细窄刀光和克制剑气",
        wardrobe: "以袍服裁片、袖口收放、腰带与鞋履辨身份，斗笠和兵刃随资产设定出现",
        forbid: "游戏界面、全景魔法光幕、恒定飘动衣角、无剧情依据的兵刃或表演动作",
    },

    // ===== 2D 漫剧 =====
    {
        id: "2d-guofeng",
        name: "国风漫剧",
        category: "2d",
        hot: true,
        tags: ["古风", "仙侠", "宫斗"],
        description: "国风 2D 动画，工笔线条与古典配色。",
        cover: cover("chinese-2d"),
        palette: ["#3b0d0c", "#b45309", "#f5e6c8"],
        medium: "国风 2D 动画漫剧，流畅线稿配精致赛璐璐上色，局部融入工笔与水墨晕染",
        world: "手绘古风建筑与山水",
        look: "朱砂、石青、藤黄、月白的古典配色",
        wardrobe: "东方古风美型服饰，纹样考究",
        forbid: "日式校园元素",
    },
    {
        id: "2d-anime",
        name: "日系动漫",
        category: "2d",
        hot: true,
        tags: ["热血", "奇幻", "异世界"],
        description: "日式 TV 动画赛璐璐，鲜明光影。",
        cover: cover("isekai-anime"),
        palette: ["#1e1b4b", "#6366f1", "#fda4af"],
        medium: "日式 TV 动画风格，赛璐璐两到三阶硬阴影，角色大眼高光、发丝分组清晰",
        world: "精细手绘动画背景",
        look: "色彩鲜明，天空通透，光影对比清晰",
        wardrobe: "日系动画风格服装",
    },
    {
        id: "2d-webtoon",
        name: "韩漫条漫",
        category: "2d",
        hot: true,
        tags: ["恋爱", "霸总", "逆袭"],
        description: "韩式条漫精致美型，柔和渐变上色。",
        sampleImages: sampleImages("2d-webtoon"),
        palette: ["#1f1d2b", "#8b5cf6", "#fbcfe8"],
        medium: "韩式条漫风格，角色修长美型、五官精致，线条细腻，柔和渐变上色",
        world: "都市场景，背景简洁并常用光斑虚化",
        look: "柔光与光滑皮肤高光",
        wardrobe: "都市时尚服装",
    },
    {
        id: "2d-manhua",
        name: "国漫都市",
        category: "2d",
        hot: true,
        tags: ["都市", "系统", "爽文"],
        description: "国产都市漫画风，利落线条与高对比。",
        sampleImages: sampleImages("2d-manhua"),
        palette: ["#0f172a", "#2563eb", "#f8fafc"],
        medium: "国产都市漫画动画风，线条利落，阴影块面明确，角色英俊靓丽",
        world: "现代都市、公司、校园、街头",
        look: "冷蓝与白主色，高对比光影，爽点镜头配速度线",
        wardrobe: "当代都市时尚服装",
    },
    {
        id: "2d-ancient-sweet",
        name: "古风甜宠漫",
        category: "2d",
        tags: ["古风", "甜宠", "王爷"],
        description: "粉嫩古风与柔和光晕的甜宠漫。",
        sampleImages: sampleImages("2d-ancient-sweet"),
        palette: ["#fff1f2", "#fb7185", "#fde68a"],
        medium: "二维古风情感漫画，清透薄色和细线勾出衣襟、鬓发与眉眼，以克制的表情和姿态传递关系",
        world: "按剧本布置院落、街集、厅堂或房间，用廊柱、屏风和人物距离交代情境",
        look: "米白底色配浅樱与暖金，柔光保留服装和脸部层次。花瓣、粉色光斑用于合适的情节与场景",
        wardrobe: "依时代和身份选择襦裙、袍服、便装和发式，精细纹样集中在领缘、袖口等局部",
        forbid: "场场落花、把角色统一穿成粉色、装饰泛光盖住五官、时代不符的首饰",
    },
    {
        id: "2d-healing",
        name: "日系治愈手绘",
        category: "2d",
        tags: ["治愈", "日常", "田园"],
        description: "柔和水彩背景与温暖阳光的手绘感。",
        cover: cover("nature-healing"),
        palette: ["#ecfccb", "#86efac", "#7dd3fc"],
        medium: "日系手绘动画电影风格，柔和水彩质感背景，角色线条柔和",
        world: "蓝天白云、繁茂植被、小镇与乡间",
        look: "温暖午后阳光与斑驳光影，色彩清新明亮",
        wardrobe: "朴素日常服装",
        forbid: "阴暗压抑",
    },
    {
        id: "2d-shoujo",
        name: "少女漫",
        category: "2d",
        tags: ["少女", "恋爱", "梦幻"],
        description: "梦幻粉紫、闪光花瓣与大眼细线条。",
        cover: cover("shoujo-romance"),
        palette: ["#fdf4ff", "#e879f9", "#c4b5fd"],
        medium: "细长线条的二维少女漫画，清楚描绘睫毛、虹膜层次与柔和发丝，保持角色原本年龄和脸型",
        world: "校园、室内、花园或幻想场景服从剧本，借视线和人物间距组织互动",
        look: "浅紫、暖白和柔粉打底，平静设定图保留干净轮廓，星形眼光、花瓣和散景只强化有需要的情绪镜头",
        wardrobe: "服装依剧情与人物身份选择，以褶边、缎带或领口等少量形制区分角色和场合",
        forbid: "瞳孔高光盖过视线、每个镜头满场装饰、把角色全部画成同种瞳形与年龄",
    },
    {
        id: "2d-comic",
        name: "美式漫画",
        category: "2d",
        tags: ["英雄", "动作", "热血"],
        description: "粗黑描边、网点与高对比平涂。",
        cover: cover("comic-pop"),
        palette: ["#111827", "#dc2626", "#facc15"],
        medium: "美式漫画风格，粗黑描边与强烈明暗块面，网点纹理，原色平涂",
        world: "城市天际线与街头",
        look: "高对比原色，强构图与动作张力",
        wardrobe: "英雄战衣与街头服装",
        forbid: "日式大眼萌系",
    },
    {
        id: "2d-painterly",
        name: "厚涂插画",
        category: "2d",
        tags: ["奇幻", "史诗", "原画"],
        description: "游戏原画厚涂，笔触与体积感强。",
        cover: cover("painterly-epic"),
        palette: ["#1c1917", "#9a3412", "#fcd34d"],
        medium: "二维厚涂插画，用不透明颜料色层、可见笔触和软硬边转换塑造体积，重点部位细画，背景保留概括笔触",
        world: "写实室内、街景和奇幻环境均按剧本设置，以整体色块分开前后景，在叙事重点集中材质细节",
        look: "先定明暗大关系，再用暖赭、青蓝或剧情指定色彩拉开冷暖，局部反光和暗部有不同笔触密度",
        wardrobe: "按时代和身份表现衣物，通过平涂底色叠加干刷、厚实高光或擦笔区分皮革、织物和金属",
        forbid: "赛璐璐平涂、全画面等量的碎笔触、强光造成一片白、无剧情依据的盔甲或奇幻装饰",
    },
    {
        id: "2d-dark",
        name: "暗黑哥特",
        category: "2d",
        tags: ["暗黑", "吸血鬼", "复仇"],
        description: "暗红与黑的哥特美学，阴郁华丽。",
        sampleImages: sampleImages("2d-dark"),
        palette: ["#0a0507", "#7f1d1d", "#d4d4d8"],
        medium: "黑红哥特二维动画，以尖锐线条、细排线和宽阔黑面组织轮廓，面部、手势和衣料边缘清晰",
        world: "依剧本表现城堡、钟楼、街道或内室，通过尖拱、纵向线条和前景遮挡建立结构感",
        look: "煤黑与暗红打底，冷光从窗或月下切入，绛红烛光集中在局部，保留阴影层次",
        wardrobe: "用高领、深色布料、银质扣环或窄披风体现有要求的角色造型，其他着装服从身份与时代",
        forbid: "纯黑吞没眼神与姿态、亮糖果色铺满画面、任意加入墓园或血迹",
    },
    {
        id: "2d-cyber-anime",
        name: "赛博动漫",
        category: "2d",
        tags: ["赛博", "未来", "机甲"],
        description: "霓虹撞色的未来都市动画，强发光。",
        cover: cover("cyber-anime"),
        palette: ["#0f0524", "#db2777", "#06b6d4"],
        medium: "赛博朋克动画风格，日式动画线稿配霓虹撞色上色",
        world: "雨夜都市与全息界面",
        look: "品红、青蓝、紫色强发光边缘",
        wardrobe: "机能服与机械义体",
        forbid: "古风元素",
    },
    {
        id: "2d-flat",
        name: "扁平插画",
        category: "2d",
        tags: ["扁平", "知识", "轻喜"],
        description: "简洁几何扁平风，色块干净。",
        sampleImages: sampleImages("2d-flat"),
        palette: ["#f1f5f9", "#6366f1", "#f97316"],
        medium: "几何扁平二维插画，以轮廓明确的圆角和直线分割纯色形体，描边细而统一或省略",
        world: "依据剧本提炼空间功能，用门窗、台阶和家具的大形状交代动线与前后层次",
        look: "一个中性色底、两组主辅色和少量强调色，阴影只用一级清楚的浅色块，边界保持干净",
        wardrobe: "用服装的大轮廓、领袖和主色区分角色身份，小细节仅在辨识需要时加入",
        forbid: "厚重渐变、写实纹理、五官被过分几何化后失去识别、同色背景吞没主体轮廓",
    },
    {
        id: "2d-fantasy-adventure",
        name: "奇幻冒险漫",
        category: "2d",
        tags: ["奇幻", "龙", "冒险"],
        description: "巨龙、浮空岛与魔法，宏大明亮的冒险动画。",
        cover: cover("fantasy-adventure"),
        palette: ["#0c4a6e", "#f59e0b", "#fef3c7"],
        world: "浮空岛、龙巢、魔法学院、异世界王都",
        look: "高饱和天空蓝与金色阳光，云层与光束层次丰富，大场面纵深",
        wardrobe: "冒险者皮甲、法袍、骑士铠甲",
    },
    {
        id: "2d-watercolor",
        name: "水彩治愈",
        category: "2d",
        tags: ["水彩", "治愈", "文艺"],
        description: "透明水彩晕染，柔和留白，适合温情故事。",
        cover: cover("watercolor"),
        palette: ["#e0f2fe", "#93c5fd", "#fbcfe8"],
        medium: "透明手绘水彩动画，以薄层水色、可见纸纹和湿边洇染建形，保留眼睛和关键道具的轻线",
        world: "根据剧情画出海边、小镇、室内或其他场景，借留白与淡色层次表现空气和光",
        look: "纸白作为高光，浅蓝、藕粉和薄暖灰控制明暗，从局部硬边过渡到自然渗化的远景",
        wardrobe: "衣物按身份和场合设定，用透明叠色交代棉麻及轻软衣料的方向与薄厚",
        forbid: "不透明厚涂、统一强黑阴影、边缘全糊掉、用留白省略必要的场景结构",
    },
    {
        id: "2d-chibi",
        name: "Q 版搞笑漫",
        category: "2d",
        tags: ["Q 版", "沙雕", "搞笑"],
        description: "大头小身，夸张表情与漫符，节奏轻快。",
        sampleImages: sampleImages("2d-chibi"),
        palette: ["#fff7ed", "#fb923c", "#38bdf8"],
        medium: "粗描边二维 Q 版喜剧，角色二至三头身，以夸张眉眼、姿势和跳色块表达反应，各角色保留脸型和辨识色",
        world: "按剧本简化办公室、家中或其他环境，保留动作涉及的道具和清楚的空间关系",
        look: "明快平涂配一级轻阴影，表情符号只用于有需要的笑点，角色设定图保持轮廓和动作清楚",
        wardrobe: "用少量标志性衣片和主色表现身份，常规镜头的服装配饰保持一致",
        forbid: "拟声文字、连续满屏漫符、3D 软胶反光、牺牲角色识别换夸张表情",
    },

    // ===== 艺术风格 =====
    {
        id: "art-ink",
        name: "水墨意境",
        category: "art",
        hot: true,
        tags: ["国风", "武侠", "意境"],
        description: "黑白水墨晕染与留白，写意东方美学。",
        cover: cover("ink-narrative"),
        palette: ["#f5f5f4", "#57534e", "#0c0a09"],
        medium: "宣纸写意水墨，淡湿墨晕开远景，浓墨定主体，枯笔飞白交代表面纹理，纸白留出天光和水气",
        world: "随剧本画出所需空间，以墨层浓淡、线条疏密和留白交代前后距离",
        look: "灰墨与纸白为主，朱砂或石青少量点染，人物与背景靠墨色深浅分离",
        wardrobe: "依角色与时代设计，用简练线描留住衣褶方向、身份配饰和道具轮廓",
        forbid: "高饱和满幅设色、光滑数码渐层、厚重立体渲染",
    },
    {
        id: "art-gongbi",
        name: "工笔重彩",
        category: "art",
        tags: ["工笔", "宫廷", "国潮"],
        description: "细腻勾线与矿物重彩，富丽典雅。",
        sampleImages: sampleImages("art-gongbi"),
        palette: ["#3d1c12", "#b45309", "#93c5fd"],
        medium: "中国工笔重彩画风格，细腻勾线，矿物颜料层层渲染，绢本质感",
        world: "宫苑、花鸟、楼阁",
        look: "石青石绿、朱砂与金线",
        wardrobe: "华美古装与纹样",
    },
    {
        id: "art-papercut",
        name: "剪纸皮影",
        category: "art",
        tags: ["民俗", "神话", "国潮"],
        description: "红色剪纸镂空与皮影侧身造型。",
        sampleImages: sampleImages("art-papercut"),
        palette: ["#450a0a", "#dc2626", "#fde68a"],
        medium: "中国剪纸与皮影叠层，纸片剪口清晰，透光镂花表现细节，关节轮廓和各层纸影保留手工形态",
        world: "按剧本安排空间与动作，以纸片的遮挡和间距呈现纵深，人物转身时维持可辨剪影",
        look: "朱红、暖金和墨黑分层，暖光沿镂孔透出，关键人物与背景以明暗轮廓区分",
        wardrobe: "按角色选取服饰与器物，将领襟、纹样和配饰处理成可辨的镂空与叠色",
        forbid: "真实皮肤和毛发渲染、塑料立体模型、遮挡人物轮廓的密集镂花",
    },
    {
        id: "art-noir",
        name: "黑白电影",
        category: "art",
        tags: ["复古", "悬疑", "文艺"],
        description: "高反差黑白摄影，光影切割与颗粒。",
        cover: cover("film-noir"),
        palette: ["#000000", "#525252", "#e5e5e5"],
        medium: "高反差黑白真人电影摄影，用可追溯的硬光塑造几何阴影，保留银盐颗粒和中灰层次",
        world: "以剧本所需地点、天气和年代为准，适合时用门窗或局部反光建立可读纵深",
        look: "深黑、纸白和清楚的中灰分区，保住眼神、手部与关键道具，日景也维持单色层次",
        wardrobe: "依身份和时代搭配，深浅明度与哑光或反光材质区分人物和道具",
        forbid: "彩色染色、主体被暗部完全吞没、无来源硬光、全片反复套用同一种光影图案",
    },
    {
        id: "art-film",
        name: "复古胶片",
        category: "art",
        tags: ["文艺", "怀旧", "爱情"],
        description: "柯达暖调色彩，颗粒与漏光。",
        cover: cover("retro-film"),
        palette: ["#3b2f2f", "#c2410c", "#fcd9a8"],
        medium: "复古彩色胶片摄影，自然真人肤质，暖色高光柔和过渡，低强度细颗粒贯穿整片",
        world: "按剧本确定地点和年代，保留实景材质与生活痕迹，时空变化由布景与环境光交代",
        look: "暖琥珀和微青阴影形成克制冷暖分离，肤色保持独立，局部强光可带轻微晕影",
        wardrobe: "服装道具依时代和身份确定，保留织物、木材或金属原有触感",
        forbid: "过度数码锐化、动漫化、胶片孔边框、拼贴、持续漏光或全屏橙色滤镜",
    },
    {
        id: "art-wes",
        name: "对称糖果色",
        category: "art",
        tags: ["喜剧", "文艺", "荒诞"],
        description: "严格对称构图与马卡龙配色。",
        sampleImages: sampleImages("art-wes"),
        palette: ["#fde4cf", "#f4978e", "#90dbf4"],
        medium: "真人电影布景强调对称轴、成对陈设与整齐轮廓，马卡龙粉、薄荷绿和鹅黄形成清楚的糖果色块",
        world: "按剧本安排空间，成对元素和中心轴用于合适的置景，景别与运动随镜头叙事变化",
        look: "漫射柔光均匀铺开，用哑光墙面、织物和浅色道具控制反光，保留自然肤色",
        wardrobe: "按身份和年代搭配服饰与小物，主辅色与布景互相衬托",
        forbid: "把每个镜头都做成正面居中、饱和霓虹滤镜、大面积塑料反光",
    },
    {
        id: "art-dream",
        name: "梦境超现实",
        category: "art",
        tags: ["奇幻", "心理", "悬疑"],
        description: "不可能空间，柔光雾气与粉紫靛蓝。",
        cover: cover("surreal-dream"),
        palette: ["#1e1b4b", "#a78bfa", "#fbcfe8"],
        medium: "梦境超现实，以可辨的现实材质承载失真的尺度、错位倒影或中断的空间关系，局部变化遵循同一视觉线索",
        world: "按剧本确定梦境及现实空间，同一地点选定一种主要空间变化，以重复物件或表面材质提示关联",
        look: "靛蓝、灰紫和近粉雾光逐层过渡，漫射光保留轮廓，镜面与反射只在叙事需要时出现",
        wardrobe: "保留人物身份与原有服饰，象征色或材质变化随剧情推进",
        forbid: "随机堆叠漂浮物与镜像、泛光冲淡主体、每场重复同一种梦境效果",
    },
    {
        id: "art-storybook",
        name: "绘本童话",
        category: "art",
        tags: ["童话", "儿童", "治愈"],
        description: "温暖水彩绘本，纸张纹理与柔和笔触。",
        cover: cover("storybook-fantasy"),
        palette: ["#fefce8", "#facc15", "#93c5fd"],
        medium: "纸上儿童绘本，水彩薄涂显出纸纤维和彩墨晕边，彩铅收住圆润轮廓与道具细节",
        world: "按剧本安排人物、动物或日常空间，用简明的形状和层次保留每个动作与物件的可读性",
        look: "暖黄、浅橙和自然草绿可作底色，亮暗随剧情变化，纸纹与色层始终可辨",
        wardrobe: "按人物身份呈现衣料和小物，以简化褶皱、针脚或拼色表现手作质感",
        forbid: "塑料三维质感、照片质感、纯数码渐变、遮掉纸纹的全屏柔焦",
    },
    {
        id: "art-oil",
        name: "古典油画",
        category: "art",
        tags: ["史诗", "欧式", "宫廷"],
        description: "伦勃朗光与厚重油彩，古典庄重。",
        sampleImages: sampleImages("art-oil"),
        palette: ["#1a120b", "#7c4a1e", "#e7c08a"],
        medium: "欧洲古典油画，厚涂突出受光高点，透明罩染连起深色半影，局部保留织布底纹和颜料笔触",
        world: "按剧本确定年代和环境，通过层层明暗组织人物与空间，室内和外景都保留油画表面质地",
        look: "暖赭、深褐和旧金建立明暗层次，侧光负责塑形，避免广泛金黄染色削弱材质差异",
        wardrobe: "服饰随角色与时代确定，布面、皮革、木器和金属各用不同笔触及受光表现",
        forbid: "摄影滤镜式写实、塑料浮雕质感、统一金属高光、脱离剧情的时代装束",
    },
    {
        id: "art-pixel",
        name: "像素复古",
        category: "art",
        tags: ["游戏", "复古", "搞笑"],
        description: "16-bit 像素画，有限调色板。",
        sampleImages: sampleImages("art-pixel"),
        palette: ["#111827", "#22c55e", "#f472b6"],
        medium: "16-bit 复古像素画，角色与环境共享清楚的整数像素网格，以阶梯轮廓和点阵抖动替代平滑渐层",
        world: "按剧本安排场景和景别，横向展开、正面或俯视依空间选择，前后景像素尺度保持一致",
        look: "有限色板和少量离散明暗档位，主体剪影在背景上清晰，微光仍按像素格绘制",
        wardrobe: "按身份和时代用色块区分发型、衣饰与随身物件，动作变化保持造型可辨",
        forbid: "平滑抗锯齿、照片底图、像素尺寸混杂、游戏状态栏和菜单浮层",
    },
    {
        id: "art-ukiyoe",
        name: "浮世绘",
        category: "art",
        tags: ["日式", "古典", "版画"],
        description: "木版画线条与平面色块，传统日式构图。",
        cover: cover("ukiyo-e"),
        palette: ["#1e3a5f", "#c2410c", "#f5e6c8"],
        medium: "日本浮世绘木版套色，木刻墨线勾轮廓，平整色块和细微套色边缘压在纤维纸面上",
        world: "依剧本选取时代和空间，以斜线、遮挡和高低层次表现纵深，保持平面化透视",
        look: "靛蓝、朱红和米黄为主要套色，局部可用克制的版印渐变，保住大块纸色和轮廓对比",
        wardrobe: "服饰、发式与器物随剧本确定，褶皱和纹样用墨线与有限套色描绘",
        forbid: "硬套与时代不符的和服或建筑、写实三维照明、平滑塑料渲染",
    },
    {
        id: "art-woodcut",
        name: "黑白版画",
        category: "art",
        tags: ["版画", "粗粝", "寓言"],
        description: "刻刀线条与强黑白对比，适合寓言与暗黑故事。",
        cover: cover("woodcut-print"),
        palette: ["#0a0a0a", "#525252", "#f5f5f4"],
        medium: "黑白木刻或麻胶版画，黑墨整块压印，刻刀刮出的锐利白线与交叉排线塑形，边缘保留纸纤维",
        world: "地点和人物随剧本，以大块黑白和疏密排线交代空间，将关键动作留在可辨轮廓内",
        look: "纯黑与纸白拉开反差，中间亮度靠刀痕密度形成，必要时只留一种强调色",
        wardrobe: "按角色与场景选择服饰和道具，用简化外形与刻线方向表现材质",
        forbid: "漫画网点与速度线取代刻痕、数码灰阶渐层、照片质感",
    },
    {
        id: "art-guochao-landscape",
        name: "青绿山水",
        category: "art",
        tags: ["国风", "山水", "仙境"],
        description: "青绿重彩山水，云雾缭绕，适合仙侠与神话。",
        sampleImages: sampleImages("art-guochao-landscape"),
        palette: ["#134e4a", "#5eead4", "#fef3c7"],
        medium: "中国青绿山水，以石青石绿矿物色层染峰岸，工整线描勾出山石与树木，散点透视铺展重叠空间",
        world: "跟随剧本确定景物，借坡岸、云水或路径串联各层空间，人物与所处环境保持尺度关系",
        look: "以青绿重彩与墨线构成骨架，少量金色提亮，雾水处露出纸底，远景减色减线",
        wardrobe: "服装和道具随时代与身份确定，用简洁勾线和有限设色融入山水",
        forbid: "照片式景深、三维反光、荧光青绿染满画面、落金覆盖整幅",
    },
    {
        id: "art-tech",
        name: "未来科技",
        category: "art",
        tags: ["科技", "概念", "广告"],
        description: "极简科技质感，冷白与发光线条。",
        cover: cover("future-tech"),
        palette: ["#0f172a", "#38bdf8", "#f8fafc"],
        medium: "写实三维未来科技概念渲染，拉丝金属、磨砂玻璃与透明玻璃分别呈现漫射、反光和折射，空间区块整齐清晰",
        world: "按剧本选择空间与功能，保留设备、通道和操作位的比例，界面与光带在功能需要时出现",
        look: "冷白作为体块底色，电光蓝少量标定设备边缘或光路，保留中性色深浅和材质层次",
        wardrobe: "服饰和器物按角色与场合设计，通过哑光、细织物纹理和结构接缝表现质地",
        forbid: "满屏可读界面或广告文字、过曝泛光、无规律堆叠设备、赛博霓虹与污损覆盖主体",
    },
];

const GENERATED_SAMPLE_COUNTS: Readonly<Partial<Record<string, number>>> = {
    "live-ceo": 4,
    "live-sweet": 4,
    "live-flash": 2,
    "live-heiress": 2,
    "live-rebirth": 2,
    "live-warlord": 2,
    "live-doctor": 2,
    "live-baby": 2,
    "live-palace": 4,
    "live-xianxia": 2,
    "live-wuxia": 4,
    "live-farm": 2,
    "live-republic": 4,
    "live-suspense": 4,
    "live-horror": 2,
    "live-campus": 2,
    "live-workplace": 2,
    "live-cyber": 4,
    "live-scifi": 4,
    "live-food": 4,
    "live-rural": 4,
    "live-tearjerker": 4,
    "live-neo-chinese": 4,
    "live-family": 2,
    "live-western-dream": 4,
    "live-western-luxury": 1,
    "3d-xuanhuan": 2,
    "3d-myth": 2,
    "3d-cg-real": 3,
    "3d-chibi": 4,
    "3d-clay": 4,
    "3d-toon": 2,
    "3d-pet": 4,
    "3d-mecha": 2,
    "3d-wuxia-game": 2,
    "2d-ancient-sweet": 2,
    "2d-shoujo": 4,
    "2d-painterly": 4,
    "2d-dark": 2,
    "2d-flat": 2,
    "2d-watercolor": 4,
    "2d-chibi": 2,
    "3d-cyber-game": 2,
    "3d-soda-characters": 1,
    "3d-ethereal-gufeng": 2,
    "art-ink": 4,
    "art-papercut": 2,
    "art-noir": 4,
    "art-film": 4,
    "art-wes": 2,
    "art-dream": 4,
    "art-storybook": 4,
    "art-oil": 2,
    "art-pixel": 2,
    "art-ukiyoe": 4,
    "art-woodcut": 4,
    "art-guochao-landscape": 2,
    "art-tech": 4,
};

function compile(spec: Spec): DramaStyle {
    const { medium, world, look, wardrobe, forbid, ...style } = spec;
    const coverImage = style.sampleImages?.[0] ?? style.cover;
    const generatedCount = GENERATED_SAMPLE_COUNTS[style.id];
    const existingSamples = style.sampleImages ?? (coverImage ? [coverImage] : []);
    const gallery = generatedCount ? [...existingSamples, ...Array.from({ length: generatedCount }, (_, index) => cover(`generated/${style.id}-${index + 1}`))] : style.sampleImages;
    const detail = { medium: medium || MEDIUM[spec.category], world, look, wardrobe, forbid: `${FORBID[spec.category]}${forbid ? `、${forbid}` : ""}` };
    const prompt = [detail.medium, `色彩光影：${look}`, `场景：${world}`, `服化道：${wardrobe}`, `禁止：${detail.forbid}`].join("。");
    const genreLabels = PRESET_GENRES.filter(({ key }) => presetHasGenre(style.id, key)).map(({ label }) => label);
    const tags = [...new Set([...genreLabels, ...style.tags])];
    return { ...style, tags, cover: coverImage, sampleImages: gallery, prompt, detail };
}

const referencesById = new Map(DRAMA_STYLE_REFERENCES.map((reference) => [reference.id, reference]));

function applyDramaStyleReference(spec: Pick<Spec, "id" | "name" | "category" | "tags" | "hot" | "cover" | "sampleImages">, reference: DramaStyleReference): Spec {
    const { aliases, sources, description, medium, world, look, wardrobe, forbid, palette } = reference;
    const withoutTerminator = (value: string) => value.replace(/[。；]+$/u, "");
    const importedImages = sources.flatMap(({ id, previewCount, omitCover, omitPreviews }) => {
        const directory = `/short-drama-styles/references/${id}`;
        const previews = Array.from({ length: previewCount }, (_, index) => index + 1)
            .filter((index) => !omitPreviews?.includes(index))
            .map((index) => `${directory}/${index}.jpg`);
        return omitCover ? previews : [`${directory}/cover.jpg`, ...previews];
    });
    const existingImages = spec.sampleImages?.length ? spec.sampleImages : spec.cover ? [spec.cover] : [];
    return {
        ...spec,
        aliases,
        description,
        medium: withoutTerminator(medium),
        world: withoutTerminator(world),
        look: withoutTerminator(look),
        wardrobe: withoutTerminator(wardrobe),
        forbid: withoutTerminator(forbid),
        palette,
        sampleImages: [...new Set([...existingImages, ...importedImages])],
    };
}

const newReferenceSpecs: Spec[] = DRAMA_STYLE_REFERENCES.flatMap((reference) => {
    const { id, name, category } = reference;
    if (!name || !category) return [];
    return [applyDramaStyleReference({ id, name, category, tags: [] }, reference)];
});

const PRESET_GENRES = [
    {
        key: "general",
        label: "通用",
        presetIds: [
            "live-heiress",
            "live-rebirth",
            "live-warlord",
            "live-doctor",
            "live-workplace",
            "live-food",
            "live-rural",
            "live-neo-chinese",
            "live-family",
            "3d-cg-real",
            "3d-pixar",
            "3d-chibi",
            "3d-clay",
            "3d-toon",
            "3d-pet",
            "2d-manhua",
            "2d-healing",
            "2d-comic",
            "2d-flat",
            "2d-watercolor",
            "2d-chibi",
        ],
    },
    {
        key: "sci-fi-fantasy",
        label: "科幻奇幻",
        presetIds: ["live-rebirth", "live-farm", "live-apocalypse", "live-cyber", "live-scifi", "live-western-fantasy", "3d-myth", "3d-toon", "3d-mecha", "2d-anime", "2d-painterly", "2d-dark", "2d-cyber-anime", "2d-fantasy-adventure"],
    },
    { key: "suspense", label: "悬疑诡异", presetIds: ["live-republic", "live-suspense", "live-horror", "live-apocalypse", "2d-dark"] },
    { key: "ancient-romance", label: "古代言情", presetIds: ["live-palace", "live-xianxia", "2d-guofeng", "2d-ancient-sweet"] },
    { key: "xianxia", label: "玄幻仙侠", presetIds: ["live-xianxia", "3d-guoman", "3d-xuanhuan", "3d-myth", "2d-guofeng"] },
    { key: "wuxia", label: "国风武侠", presetIds: ["live-wuxia", "3d-wuxia-game"] },
    { key: "historical", label: "年代历史", presetIds: ["live-palace", "live-farm", "live-republic", "live-era", "live-hk", "2d-guofeng"] },
    { key: "modern-romance", label: "现代言情", presetIds: ["live-ceo", "live-sweet", "live-flash", "live-baby", "live-campus", "live-tearjerker", "2d-webtoon", "2d-shoujo"] },
] as const satisfies ReadonlyArray<{ key: string; label: string; presetIds: readonly string[] }>;

export type DramaStyleTag = (typeof PRESET_GENRES)[number]["key"];

const presetIDsByGenre = new Map(PRESET_GENRES.map(({ key, presetIds }) => [key, new Set<string>(presetIds)]));

function presetHasGenre(id: string, tag: DramaStyleTag) {
    return presetIDsByGenre.get(tag)?.has(id) || referencesById.get(id)?.genres.includes(tag);
}

export const DRAMA_STYLES: DramaStyle[] = [
    ...SPECS.map((spec) => {
        const reference = referencesById.get(spec.id);
        return compile(reference ? applyDramaStyleReference(spec, reference) : spec);
    }),
    ...newReferenceSpecs.map(compile),
];

export const dramaReferenceStyles = DRAMA_STYLES.filter((style) => referencesById.has(style.id));

// 早期作品只保存风格全文。用旧版本文本的 SHA-256 恢复样图，手工改写仍按自定义风格处理。
const legacyPresetIds = new Map(Object.entries(legacyStylePromptDigests));

export function findDramaStyleByLegacyPrompt(prompt: string) {
    const id = legacyPresetIds.get(bytesToHex(sha256(new TextEncoder().encode(prompt.trim()))));
    return id ? findDramaStyle(id) : undefined;
}

function dramaStyleCatalogForType(type?: string) {
    return type === "live_action" ? dramaStyleCatalog.live_action : dramaStyleCatalog.comic;
}

export function dramaStylePresetsForType(type?: string): DramaStyle[] {
    const ids = new Set(dramaStyleCatalogForType(type).presetIds);
    return DRAMA_STYLES.filter((style) => ids.has(style.id));
}

export function dramaStyleTagsForType(type?: string): readonly { key: "all" | DramaStyleTag; label: string }[] {
    const presets = dramaStylePresetsForType(type);
    return [{ key: "all", label: "全部" }, ...PRESET_GENRES.filter(({ key }) => presets.some(({ id }) => presetHasGenre(id, key))).map(({ key, label }) => ({ key, label }))];
}

export function filterDramaStylePresets(type?: string, tag: "all" | DramaStyleTag = "all", query = ""): DramaStyle[] {
    const keyword = query.trim();
    return dramaStylePresetsForType(type).filter((style) => (tag === "all" || presetHasGenre(style.id, tag)) && matchesDramaStyleSearch(style, keyword));
}

export function defaultDramaStyleForType(type?: string): DramaStyle {
    const { defaultPresetId } = dramaStyleCatalogForType(type);
    const style = DRAMA_STYLES.find((item) => item.id === defaultPresetId);
    if (!style) throw new Error(`找不到剧集类型的默认风格：${defaultPresetId}`);
    return style;
}

export function findDramaStyle(id: string): DramaStyle | undefined {
    return findComposedDramaStyle(id) || DRAMA_STYLES.find((style) => style.id === id);
}

const PRESET_THEME_GROUPS: Array<{ themeId: DramaStyleThemeId; ids: string[] }> = [
    {
        themeId: "urban",
        ids: ["live-ceo", "live-heiress", "live-rebirth", "live-warlord", "live-doctor", "live-workplace", "live-family", "live-neo-chinese", "live-food", "3d-pixar", "3d-pet", "2d-webtoon", "2d-manhua", "2d-comic", "2d-flat", "2d-chibi"],
    },
    { themeId: "romance", ids: ["live-sweet", "live-flash", "live-baby", "live-tearjerker", "2d-ancient-sweet", "2d-shoujo"] },
    { themeId: "xuanhuan", ids: ["live-xianxia", "3d-guoman", "3d-xuanhuan", "3d-myth", "2d-guofeng", "art-papercut", "art-guochao-landscape"] },
    { themeId: "apocalypse", ids: ["live-apocalypse"] },
    { themeId: "palace", ids: ["live-palace", "art-gongbi", "art-oil"] },
    { themeId: "wuxia", ids: ["live-wuxia", "3d-wuxia-game", "art-ink"] },
    { themeId: "campus", ids: ["live-campus", "3d-toon"] },
    { themeId: "suspense", ids: ["live-suspense", "live-horror", "art-noir"] },
    { themeId: "scifi", ids: ["live-cyber", "live-scifi", "3d-mecha", "2d-cyber-anime", "art-tech"] },
    { themeId: "rural", ids: ["live-farm", "live-rural", "2d-healing"] },
    { themeId: "historical", ids: ["live-republic", "live-era", "live-hk", "art-film", "art-wes", "art-ukiyoe"] },
    { themeId: "fantasy", ids: ["live-western-fantasy", "2d-anime", "2d-painterly", "2d-dark", "2d-fantasy-adventure", "art-dream", "art-storybook"] },
];
const presetThemes = new Map(PRESET_THEME_GROUPS.flatMap(({ themeId, ids }) => ids.map((id) => [id, themeId] as const)));
const CATEGORY_FORM: Record<DramaStyleCategory, DramaStyleFormId> = { live: "realistic", "3d": "3d", "2d": "2d", art: "semi-realistic" };

/** 预设只提供开始自由组合时的轴选项；未操作时仍保留原预设的完整提示词。 */
export function getDramaStyleComposition(id: string): DramaStyleComposition | undefined {
    const composition = parseDramaStyleId(id);
    if (composition) return composition;
    const preset = DRAMA_STYLES.find((style) => style.id === id);
    if (!preset) return undefined;
    const photographic = ["art-noir", "art-film", "art-wes"].includes(id);
    return { formId: photographic ? "realistic" : CATEGORY_FORM[preset.category], themeId: presetThemes.get(id) || "story" };
}

export function updateDramaStyleComposition(id: string, patch: Partial<DramaStyleComposition>): string {
    const current = getDramaStyleComposition(id) || parseDramaStyleId(DEFAULT_DRAMA_STYLE_ID)!;
    return composeDramaStyleId(patch.formId ?? current.formId, patch.themeId ?? current.themeId);
}

export function styleCoverBackground(style: Pick<DramaStyle, "cover" | "palette">) {
    const [a, b, c] = style.palette;
    return style.cover ? `center / cover no-repeat url(${style.cover})` : `radial-gradient(110% 80% at 80% 15%, ${c}d9, transparent 60%), linear-gradient(160deg, ${a}, ${b})`;
}

export function filterDramaStyles(category: "all" | "hot" | DramaStyleCategory, query: string) {
    const keyword = query.trim();
    return DRAMA_STYLES.filter((style) => {
        if (category === "hot" && !style.hot) return false;
        if (category !== "all" && category !== "hot" && style.category !== category) return false;
        return matchesDramaStyleSearch(style, keyword);
    });
}

function matchesDramaStyleSearch(style: DramaStyle, keyword: string) {
    return !keyword || [style.name, style.description, ...style.tags, ...(style.aliases || [])].some((value) => value.includes(keyword));
}
