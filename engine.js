/* 腐潮 / ROT TIDE —— 纯前端引擎（由 engine.py 1:1 移植）
 *
 * 为什么要移植：原来的规则跑在 Python 服务端，必须有人架服务器才能玩。
 * 搬到浏览器后整个游戏就是几个静态文件，任何免费静态托管（GitHub Pages 等）
 * 都能直接跑；存档也从服务端文件改成 localStorage —— 按浏览器隔离，
 * 你把链接发给别人，别人的进度不会覆盖你的。
 *
 * 零依赖，浏览器 / Node 通用。规则逻辑与 engine.py 完全一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ROT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

// ─────────────────────────── 常量 ───────────────────────────
const VERSION = "0.9.13";
const BUILD = "2026-11-25";

const W = 24, H = 16;

const STREET = 0, RUBBLE = 1, WALL = 2, WATER = 3,
      WHEAT = 4, CAR = 5, TREE = 6, MAT = 7, SAND = 8, SHOAL = 9;

/* 地形表：cost 移动消耗 / cover 减伤 / blockLos 挡视线 / healZ 丧尸站上面每回合回血
 * pat 只是给前端画图案用的标签，规则完全不关心。 */
const TERR = [
  { name: "街道", cost: 1, color: "#1e242e", pat: "street", desc: "普通地面" },
  { name: "废墟", cost: 1, cover: 1, color: "#4a3f31", pat: "rubble", desc: "掩体：受到的伤害 -1" },
  { name: "建筑", cost: 99, block: true, color: "#6d7f9c", pat: "wall", desc: "不可通行，阻挡视线" },
  { name: "污水", cost: 2, color: "#1b5372", pat: "water", desc: "移动消耗 2" },
  { name: "麦田", cost: 2, blockLos: true, color: "#4d5a25", pat: "wheat", desc: "可通行（消耗 2），但挡住视线" },
  { name: "车阵", cost: 2, cover: 2, color: "#39485c", pat: "car", desc: "可通行（消耗 2），掩体减伤 2" },
  { name: "树丛", cost: 2, cover: 1, blockLos: true, color: "#1d4635", pat: "tree", desc: "可通行（消耗 2），挡视线，掩体 -1" },
  { name: "菌毯", cost: 1, healZ: 1, color: "#3f2b4d", pat: "mat", desc: "丧尸站上去每回合回 1 血" },
  { name: "沙地", cost: 2, color: "#6a5b3d", pat: "sand", desc: "松软，移动消耗 2" },
  { name: "浅滩", cost: 3, color: "#22606e", pat: "shoal", desc: "移动消耗 3" },
];
const WALK_COST = TERR.map((t) => t.cost);
const coverAt = (t) => (TERR[t] && TERR[t].cover) || 0;
const blocksLOS = (t) => t === WALL || !!(TERR[t] && TERR[t].blockLos);

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
const DIRS8_N = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]];

const MAX_LVL = 3;

// 丧尸（玩家方）：hp/atk/rng/sight 是 Lv1 数值（刻意偏低），up 是每级增量
// unlock_lvl = 母巢升到几级时解锁该形态（0 = 开局就能孵）
const ZTYPES = {
  scent: {
    name: "嗅探者", short: "嗅", hp: 3, atk: 1, rng: 1, sight: 8,
    up: { hp: 2, atk: 1, sight: 2 },
    color: "#4fd8f0", shape: "diamond", unlock_lvl: 0,
    skill: "拆解视野：Lv1 十字 5 格 / Lv2 九宫格 9 格 / Lv3 5×5 25 格（随等级扩大）",
    blurb: "视野极广，开局唯一能撕开黑幕的单位",
  },
  ripper: {
    name: "撕裂者", short: "裂", hp: 4, atk: 2, rng: 1, sight: 3,
    up: { hp: 2, atk: 2 },
    color: "#ff5c5c", shape: "triangle", unlock_lvl: 0,
    skill: "撕裂：对相邻敌人造成双倍伤害，自损 1",
    blurb: "近战爆发最高，但一级只够撕开平民",
  },
  bulwark: {
    name: "肉垒", short: "垒", hp: 10, atk: 1, rng: 1, sight: 3,
    up: { hp: 4, atk: 1 },
    color: "#8fa3c8", shape: "square", unlock_lvl: 4,
    skill: "筑垒：自身 +3 护盾，相邻友军 +1 护盾；被动：肉垒站在母巢 3 格内时，远程人类优先攻击肉垒",
    blurb: "中后期肉盾，用嘲讽把狙击手等远程人类的枪口从母巢引开",
  },
  spitter: {
    name: "喷吐者", short: "吐", hp: 4, atk: 2, rng: 4, sight: 4,
    up: { hp: 2, atk: 1, rng: 1 },
    color: "#a8e05f", shape: "circle", unlock_lvl: 0,
    skill: "酸蚀：对目标及其周围 1 格造成攻击力-1 的伤害",
    blurb: "唯一的远程手段，专治抱团人类",
  },
  skitter: {
    name: "爬行者", short: "爬", hp: 3, atk: 2, rng: 1, sight: 5,
    up: { hp: 2, atk: 1 },
    color: "#ffb86b", shape: "triangle", unlock_lvl: 2,
    skill: "疾行：立刻返还一次行动次数（只花 1 腐能）",
    blurb: "四肢反折的速度型，一回合能摸到后排",
  },
  rotter: {
    name: "催腐者", short: "腐", hp: 2, atk: 0, rng: 1, sight: 4,
    up: { hp: 1, sight: 1 },
    color: "#c6e86a", shape: "circle", unlock_lvl: 3,
    skill: "腐解：立刻自毁，为母巢提供 8+3×等级 经验",
    blurb: "没有攻击力，蹲在后排每回合给母巢喂 1 点经验",
  },
  bloat: {
    name: "爆裂体", short: "爆", hp: 7, atk: 1, rng: 1, sight: 3,
    up: { hp: 3, atk: 1 },
    color: "#e8a33d", shape: "circle", unlock_lvl: 5,
    skill: "胀裂：对相邻所有敌人造成 5+2×等级 伤害，自身死亡",
    blurb: "一次性的解围手段，用来换掉扎堆的枪口",
  },
  weaver: {
    name: "编织者", short: "织", hp: 4, atk: 1, rng: 3, sight: 5,
    up: { hp: 2, atk: 1, rng: 1 },
    color: "#c99bff", shape: "diamond", unlock_lvl: 7,
    skill: "缠丝：目标 1 回合内无法移动（仍可攻击）",
    blurb: "控场核心，把冲锋的士兵钉在原地",
  },
};

// 人类（敌方）：melee8 = 八方向近战；atks = 每回合攻击次数；aim = 瞄准回合数
const HTYPES = {
  civilian: { name: "市民", short: "市", hp: 3, atk: 1, rng: 1, sight: 4,
              color: "#d9cba8", shape: "circle", flee: true },
  officer: { name: "警员", short: "警", hp: 6, atk: 3, rng: 4, sight: 6,
             color: "#7ea6ff", shape: "square", hunt: 0.45 },
  shield: { name: "盾卫", short: "盾", hp: 12, atk: 2, rng: 1, sight: 4,
            color: "#b9c6d8", shape: "square", melee8: true, hunt: 0.58 },
  brawler: { name: "格斗家", short: "拳", hp: 5, atk: 3, rng: 1, sight: 5,
             color: "#ff8fa3", shape: "triangle", melee8: true, atks: 2, hunt: 0.72 },
  soldier: { name: "士兵", short: "兵", hp: 7, atk: 3, rng: 6, sight: 6,
             color: "#ffd166", shape: "square", hunt: 0.6 },
  medic: { name: "医生", short: "医", hp: 4, atk: 1, rng: 2, sight: 4,
           color: "#8ef0bb", shape: "diamond", heal: 2, hunt: 0.35 },
  sniper: { name: "狙击手", short: "狙", hp: 3, atk: 6, rng: 9, sight: 9,
            color: "#ff9f43", shape: "triangle", aim: 2, hunt: 0.18 },
};

const MOTHERS = {
  brood: { name: "巢母", hp: 14, skill: "孵化", cd: 3, atk: 0,
           color: "#c07cff", short: "巢", shape: "diamond",
           desc: "在母体相邻空格直接诞生一只撕裂者" },
  mycelia: { name: "菌母", hp: 12, skill: "菌丝网络", cd: 3, atk: 0,
             color: "#7ce0c0", short: "菌", shape: "diamond",
             desc: "本回合全体丧尸视野翻倍、腐能 +1" },
  carapace: { name: "磐母", hp: 16, skill: "甲壳", cd: 4, atk: 0,
              color: "#9fb3d8", short: "磐", shape: "diamond",
              desc: "母体及周围 2 格友军获得 4 点护盾" },
};

const DIFFS = {
  easy: { ap: 6, start_z: 4, start_h: 4, spawn_every: 5, spawn_n: 2, turns: 14, label: "疫潮初起" },
  normal: { ap: 5, start_z: 3, start_h: 4, spawn_every: 5, spawn_n: 2, turns: 16, label: "尸潮涌动" },
  hard: { ap: 4, start_z: 3, start_h: 5, spawn_every: 5, spawn_n: 3, turns: 18, label: "末日余烬" },
};

const AP_NAME = "腐能";
const AP_GROW_EVERY = 2;
const AP_GROW_MAX = 6;
const COCOON_LIFE = 8;

const MAPS_PER_RUN = 5;
const LAYERS_PER_MAP = 2;
const RUN_LAYERS = MAPS_PER_RUN * LAYERS_PER_MAP;

const LAYER_CLEAR_BIO = 3;
const CLEAR_ATK = 1;
const CLEAR_HP_PCT = 0.16;
const CLEAR_HEAL_PCT = 1.0;
const MOTHER_CLEAR_HP = 4;
const H_HP_PER_DEPTH = 3;
const H_ATK_PER_DEPTH = 5;
const H_COUNT_PER_DEPTH = 5;
const AP_PER_DEPTH = 1;

/* 地图顺序固定：实验室（无特殊地形）→ 村庄 → 城区 → 森林 → 海岸
 * specials: [[地形, 数量], ...]，由 _gen_map_once 撒在地图上 */
// ── 新手教程：四节固定小课，每节只教一个机制 ────────────
// map 是 24×16 的字符画（'#'=建筑 '.'=街道 ','=废墟 '~'=污水），只用中间一小块，
// 四周全封墙，保证没有意外通路；mother 是 2×2 左上角坐标。
const TUT_LEVELS = [
  {
    name: "第 1 课 · 走动与腐能",
    goal: "move", goalText: "用任意一只丧尸移动一次",
    hint: "左键点一只丧尸选中它，再点蓝色格子移动。每走一格要花【腐能】，每回合回满。",
    ap: 3,
    mother: [4, 6],
    zombies: [["ripper", 9, 7], ["scent", 8, 10]],
    humans: [],
    relic: null,
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....,##................#",
      "#....,##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
  },
  {
    name: "第 2 课 · 攻击与视线",
    goal: "kill", goalText: "打死那名市民",
    hint: "点敌人所在格（或它脚下的红圈）就能攻击。近战要先贴到相邻格；打死后原地会留下【尸茧】。",
    ap: 4,
    mother: [4, 6],
    zombies: [["ripper", 9, 7], ["spitter", 8, 11]],
    humans: [["civilian", 12, 7]],
    relic: null,
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....,##................#",
      "#....,##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#...........,,,,,......#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
  },
  {
    name: "第 3 课 · 尸茧与孵化",
    goal: "hatch", goalText: "先击杀市民，再用尸茧孵化一只新丧尸",
    hint: "这一课没有现成尸茧：先打死场上的市民，尸茧会留在倒下的位置；让丧尸走上去，在面板里选「① 孵化」。",
    ap: 5,
    mother: [4, 6],
    zombies: [["ripper", 9, 7], ["scent", 9, 10]],
    humans: [["civilian", 11, 7]],
    relic: null,
    clearCocoons: true,
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....,##................#",
      "#....,##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
  },
  {
    name: "第 4 课 · 尸茧与升级",
    goal: "evolve", goalText: "先击杀市民，再让丧尸吞茧升到 Lv2",
    hint: "先打死场上的市民取得尸茧；让丧尸走上去，这次选「② 升级」，血量、攻击、射程和视野都会永久提高。",
    ap: 5,
    mother: [4, 6],
    zombies: [["ripper", 9, 7], ["scent", 9, 10]],
    humans: [["civilian", 11, 7]],
    relic: null,
    clearCocoons: true,
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....,##................#",
      "#....,##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
  },
  {
    name: "第 5 课 · 母巢技能",
    goal: "mother", goalText: "按 Q 使用一次母巢技能",
    hint: "母巢技能不花腐能，只受冷却限制——左侧【母巢】卡上正在呼吸发光的「发动」按钮就是它。",
    ap: 5,
    mother: [4, 6],
    zombies: [["ripper", 9, 7], ["spitter", 9, 10]],
    humans: [],
    relic: null,
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....,##................#",
      "#....,##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
  },
  {
    name: "第 6 课 · 感染物",
    goal: "relic", goalText: "捡起一枚感染物",
    hint: "地图上发光的晶体就是感染物；让一只丧尸走上去捡起它，会永久强化全队。",
    ap: 5,
    mother: [4, 6],
    zombies: [["ripper", 9, 7], ["spitter", 9, 10]],
    humans: [],
    relic: ["spleen", 12, 8],
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....,##................#",
      "#....,##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
  },
];

const MAPS = [
  { name: "废弃实验室", sub: "冷白的培养舱与消毒走廊，没有特殊地形，只有墙和水",
    walls: 1.15, rubble: 44, water: 6, police: 0.12, military: 0.05, specials: [] },
  { name: "枯败村庄", sub: "齐腰的麦田挡住视线，尸群可以摸到很近才被发现",
    walls: 0.78, rubble: 46, water: 4, police: 0.16, military: 0.06,
    specials: [[WHEAT, 64]] },
  { name: "沉没城区", sub: "熄火的车阵既是掩体，也是人类最后的街垒",
    walls: 1.3, rubble: 76, water: 4, police: 0.34, military: 0.2,
    specials: [[CAR, 34]] },
  { name: "腐化森林", sub: "菌毯铺满林间给养尸群，树影则替人类藏枪",
    walls: 0.5, rubble: 34, water: 8, police: 0.12, military: 0.34,
    specials: [[TREE, 88], [MAT, 30]] },
  { name: "崩塌海岸", sub: "沙地陷脚、浅滩拖步，开阔得让人无处可藏",
    walls: 0.44, rubble: 38, water: 10, police: 0.16, military: 0.4,
    specials: [[SAND, 96], [SHOAL, 34]] },
];

const ACT_PER_UNIT = 2;      // 已废弃：不再限制每单位行动次数，改为只受腐能约束（保留常量以免旧存档字段报错）
const ATK_AP = 1;
const SKILL_AP = 1;
const ENEMY_STEP = 2;
const WIN_BIOMASS = 5;

// ── 母巢：占 2×2 四格 ──
const MOTHER_SIZE = 2;

// ── 母巢等级 / 经验 ──
// 击杀人类得经验，撑过一层也得；每升一级产出一枚感染物，
// 每 3 级孵化出的丧尸初始等级 +1（感染人类的质量随母巢成长而提高）。
const EXP_KILL = { civilian: 1, officer: 2, brawler: 2, shield: 3, soldier: 3, medic: 2, sniper: 4 };
const EXP_LAYER = 10;
const EXP_ROTTER = 1;           // 每只活着的催腐者，每回合给母巢的经验
const HATCH_LVL_EVERY = 3;      // 每多少级母巢，孵化等级 +1

// 0.8 起升级曲线明显拉长（旧版 6+4L），配合 10 层远征与催腐者的持续供能
function expNeed(lvl) { return 10 + lvl * 8; }

// ── 感染物（遗物）：分四档稀有度，越稀有越靠后才能刷到 ──
// r = 稀有度下标（见 RARITY）。低阶只加一点点属性，高阶给机制，成对还能凑连携。
const RELICS = {
  // ── 常见：只加很小的一点基础属性 ──
  spleen: { name: "酸囊", tag: "攻", r: 0, color: "#ff7a59",
            desc: "所有丧尸攻击 +1", fx: { atk: 1 } },
  plate: { name: "厚甲", tag: "血", r: 0, color: "#7fb3ff",
           desc: "所有丧尸生命上限 +1", fx: { hp: 1 } },
  eye: { name: "眼巢", tag: "视", r: 0, color: "#4fd8f0",
         desc: "所有丧尸视野 +1", fx: { sight: 1 } },
  core: { name: "腐核", tag: "能", r: 0, color: "#c07cff",
          desc: "每回合腐能上限 +1", fx: { apmax: 1 } },
  bile: { name: "胆汁腺", tag: "物", r: 0, color: "#e8a33d",
          desc: "每次击杀额外获得 1 生物质", fx: { bio: 1 } },
  spore: { name: "孢子云", tag: "茧", r: 0, color: "#8ef0bb",
           desc: "尸茧留存时间 +3 回合", fx: { cocoon: 3 } },

  // ── 精良：一条完整的小机制 ──
  flesh: { name: "噬肉菌", tag: "噬", r: 1, color: "#a8e05f",
           desc: "丧尸每次击杀回复 2 点生命", fx: { leech: 2 } },
  echo: { name: "回响腺", tag: "愈", r: 1, color: "#7ce0c0",
          desc: "每回合开始时，受伤最重的丧尸回复 2 点生命", fx: { regen: 2 } },
  thorn: { name: "角质刺", tag: "程", r: 1, color: "#c9a0ff",
           desc: "所有丧尸射程 +1", fx: { rng: 1 } },
  gland: { name: "腺体增生", tag: "验", r: 1, color: "#ffd166",
           desc: "每次击杀额外获得 1 点母巢经验", fx: { expk: 1 } },
  shell: { name: "壳质层", tag: "壳", r: 1, color: "#9fb3d8",
           desc: "每回合开始，全体丧尸获得 1 点护盾", fx: { ward: 1 } },
  muscle: { name: "肌纤维", tag: "肌", r: 1, color: "#ff8fa3",
            desc: "攻击 +1，生命上限 +2", fx: { atk: 1, hp: 2 } },

  // ── 稀有：改变打法，靠后才能刷到 ──
  fang: { name: "穿甲齿", tag: "穿", r: 2, color: "#ff5c5c",
          desc: "丧尸的攻击无视掩体减伤", fx: { pierce: 1 } },
  cyst: { name: "裂爆囊", tag: "爆", r: 2, color: "#e8a33d",
          desc: "近战攻击会溅射目标周围 1 格（半伤）", fx: { splash: 1 } },
  frenzy: { name: "狂化腺", tag: "狂", r: 2, color: "#ff7043",
            desc: "每次击杀立刻返还 1 点腐能", fx: { frenzy: 1 } },
  node: { name: "神经节", tag: "节", r: 2, color: "#8b5cf6",
          desc: "母体技能冷却 -1 回合", fx: { mind: 1 } },
  husk: { name: "巨巢壳", tag: "巢", r: 2, color: "#b47cff",
          desc: "母巢生命上限 +8", fx: { girth: 8 } },
  wrap: { name: "蛹衣", tag: "孵", r: 2, color: "#ffd166",
          desc: "孵化出的丧尸初始等级 +1", fx: { hatch: 1 } },

  // ── 传说：两三条机制叠在一起 ──
  heart: { name: "母巢之心", tag: "心", r: 3, color: "#d8b4fe",
           desc: "母巢生命上限 +14，孵化等级 +1", fx: { girth: 14, hatch: 1 } },
  lung: { name: "瘟疫之肺", tag: "疫", r: 3, color: "#7ce0c0",
          desc: "每次击杀额外 2 点经验，腐能上限 +1", fx: { expk: 2, apmax: 1 } },
  crown: { name: "腐冠", tag: "冠", r: 3, color: "#ffb347",
           desc: "攻击 +2、生命 +3、视野 +2", fx: { atk: 2, hp: 3, sight: 2 } },
};

// w = 抽到该档的相对权重，min = 从第几层（depth）起才可能出现在池子里
const RARITY = [
  { name: "常见", color: "#9aa7b8", w: 50, min: 0 },
  { name: "精良", color: "#5ecbe8", w: 27, min: 2 },
  { name: "稀有", color: "#b47cff", w: 17, min: 4 },
  { name: "传说", color: "#ffb347", w: 6, min: 6 },
];

// 成对连携：两件都在手就自动生效，不需要占第三个格子
const PAIRS = [
  { id: "venom", name: "毒血共鸣", need: ["spleen", "thorn"],
    desc: "攻击无视掩体，且近战攻击溅射相邻敌人", fx: { pierce: 1, splash: 1 } },
  { id: "brood", name: "育巢共振", need: ["spore", "wrap"],
    desc: "尸茧再 +4 回合，孵化等级再 +1", fx: { cocoon: 4, hatch: 1 } },
  { id: "sap", name: "吮吸之环", need: ["flesh", "bile"],
    desc: "击杀再回 2 血，额外 +1 生物质", fx: { leech: 2, bio: 1 } },
];

const RELIC_DROP_CHANCE = 0.22;   // 每回合地图上刷出感染物的概率
const RELIC_LIFE = 14;            // 没人捡，多久消失

/* ── 突变（层间事件）────────────────────────────────────
 * 清完一层、往下一层走的时候，有概率先掉进一个「突变层」。
 * 突变层里不打架，只花【本局生物质】买突变：三项随机能力，
 * 每项只能拿一次，数值越大标价越贵。 */
const MUTATION_CHANCE = 0.35;     // 每次下潜触发突变的概率
const MUTATION_GAP = 2;           // 两次突变之间至少隔这么多层（depth 差）
const MUTATION_COST = {           // 突变价目（生物质）
  exp: (v) => Math.max(4, Math.round(v * 0.45)),
  relic: (r, d) => [8, 15, 24, 36][r] + Math.floor(d / 2),
  zombie: (lvl) => 6 + lvl * 6,
  upgrade: (v) => 7 + v * 6,
};

const START_UNLOCKED = ["scent", "ripper", "spitter"];

const FX_KEYS = ["atk", "hp", "sight", "rng", "apmax", "leech", "cocoon", "bio",
                 "hatch", "regen", "expk", "ward", "pierce", "splash", "frenzy",
                 "mind", "girth"];

function relicBonus(list) {
  const o = {};
  for (const k of FX_KEYS) o[k] = 0;
  const add = (f) => { for (const k of Object.keys(f)) if (k in o) o[k] += f[k]; };
  for (const id of list) {
    const r = RELICS[id];
    if (r && r.fx) add(r.fx);
  }
  for (const p of PAIRS) {
    if (p.need.every((k) => list.indexOf(k) >= 0)) add(p.fx);
  }
  return o;
}

function activePairs(list) {
  return PAIRS.filter((p) => p.need.every((k) => list.indexOf(k) >= 0)).map((p) => p.id);
}

/** 按稀有度抽一枚还没有的感染物；深度不够时只出低阶 */
function rollRelic(rng, depth, owned) {
  const pool = Object.keys(RELICS).filter((k) => owned.indexOf(k) < 0);
  if (!pool.length) return null;
  const avail = pool.filter((k) => RARITY[RELICS[k].r].min <= depth);
  const use = avail.length ? avail : pool;
  const byR = {};
  for (const k of use) {
    const r = RELICS[k].r;
    (byR[r] = byR[r] || []).push(k);
  }
  const tiers = Object.keys(byR).map(Number).sort((a, b) => a - b);
  let total = 0;
  for (const r of tiers) total += RARITY[r].w;
  let x = rng.random() * total, pick = tiers[tiers.length - 1];
  for (const r of tiers) {
    if (x < RARITY[r].w) { pick = r; break; }
    x -= RARITY[r].w;
  }
  return rng.choice(byR[pick]);
}

// ─────────────────────────── 小工具 ───────────────────────────

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const int = (v) => (typeof v === "number" ? Math.trunc(v) : parseInt(v, 10) || 0);
/** 安全的 "key in obj"：JS 里 `undefined in obj` 会抛 TypeError，所有查表都走它 */
const has = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);

/** Python 的 round() 是银行家舍入（round(2.5)===2），地图密度要用它才对得上。 */
function pyRound(v) {
  const f = Math.floor(v), d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

class ActError extends Error {}

const key = (x, y) => x + "," + y;

function distp(x0, y0, x1, y1) { return Math.sqrt((x0 - x1) * (x0 - x1) + (y0 - y1) * (y0 - y1)); }
function dist(a, b) { return distp(a.x, a.y, b.x, b.y); }
function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

/** 确定性伪随机（xorshift32）。比 Math.random 好：种子固定 → 局面可复现、可存档。 */
class RNG {
  constructor(seed) {
    this.s = (int(seed) >>> 0);
    if (this.s === 0) this.s = 0x9e3779b9;
  }
  next() {
    let x = this.s >>> 0;
    x ^= (x << 13); x >>>= 0;
    x ^= (x >>> 17);
    x ^= (x << 5); x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  random() { return this.next(); }
  randrange(a, b) { return a + Math.floor(this.next() * (b - a)); }
  randint(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  choice(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  getState() { return this.s >>> 0; }
  setState(v) { const s = int(v) >>> 0; this.s = s === 0 ? 0x9e3779b9 : s; }
}

/** Dijkstra 用的二叉小顶堆 */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(d, k) {
    const a = this.a;
    a.push([d, k]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        const t = a[s]; a[s] = a[i]; a[i] = t;
        i = s;
      }
    }
    return top;
  }
}

function zstats(kind, lvl) {
  const b = ZTYPES[kind];
  const up = b.up || {};
  const k = clamp(int(lvl), 1, MAX_LVL) - 1;
  return {
    hp: b.hp + (up.hp || 0) * k,
    atk: b.atk + (up.atk || 0) * k,
    rng: b.rng + (up.rng || 0) * k,
    sight: b.sight + (up.sight || 0) * k,
  };
}

/** 嗅探者扫描范围：Lv1 十字 5 格 / Lv2 九宫格 9 格 / Lv3 5×5 25 格。 */
function scentCells(lvl, cx, cy) {
  const L = clamp(int(lvl), 1, MAX_LVL);
  const out = [];
  const add = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) out.push([x, y]); };
  if (L <= 1) {
    add(cx, cy);
    add(cx + 1, cy); add(cx - 1, cy);
    add(cx, cy + 1); add(cx, cy - 1);
    return out;
  }
  const r = L === 2 ? 1 : 2;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) add(x, y);
  }
  return out;
}

// ─────────────────────────── 存档（localStorage）───────────────────────────

const SAVE_KEY = "rottide.save.v1";
let MEM_SAVE = null;      // Node 下的内存兜底（浏览器永远走 localStorage）

function _readRaw() {
  if (typeof localStorage === "undefined") return MEM_SAVE;
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch (e) { return null; }
}
function _writeRaw(d) {
  if (typeof localStorage === "undefined") { MEM_SAVE = d; return; }
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(d)); } catch (e) { /* 隐私模式写不进就算了，本局照玩 */ }
}

function defaultSave() {
  return {
    biomass: 0,
    runs: 0,
    wins: 0,
    best_infected: 0,
    best_depth: 0,
    run: null,
  };
}

function loadSave() {
  const d = defaultSave();
  const raw = _readRaw();
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(d)) if (k in raw) d[k] = raw[k];
  }
  d.biomass = Math.max(0, int(d.biomass));
  d.runs = Math.max(0, int(d.runs));
  d.wins = Math.max(0, int(d.wins));
  d.best_infected = Math.max(0, int(d.best_infected));
  d.best_depth = Math.max(0, int(d.best_depth));
  return d;
}

function writeSave(d) { _writeRaw(d); }

function profilePublic(s) {
  s = s || loadSave();
  const run = s.run;
  let brief = null;
  if (run && typeof run === "object") {
    const diff = has(DIFFS, run.diff) ? run.diff : "normal";
    const mi = clamp(int(run.map_i), 0, MAPS_PER_RUN - 1);
    const li = clamp(int(run.layer_i), 0, LAYERS_PER_MAP - 1);
    brief = {
      turn: int(run.turn) || 1,
      turns_total: DIFFS[diff].turns,
      diff: diff,
      diff_label: DIFFS[diff].label,
      mother: (has(MOTHERS, run.mother) ? MOTHERS[run.mother] : MOTHERS.brood).name,
      map: MAPS[Math.min(mi, MAPS.length - 1)].name,
      map_i: mi, maps: MAPS_PER_RUN,
      layer: li, layers: LAYERS_PER_MAP,
      depth: mi * LAYERS_PER_MAP + li, run_layers: RUN_LAYERS,
      stage_clear: !!run.stage_clear,
      infected: int(run.infected),
      biomass: int(run.biomass),
      mother_lvl: Math.max(1, int(run.mother_lvl) || 1),
      relics: (run.relics || []).length,
    };
  }
  return {
    version: VERSION,
    build: BUILD,
    biomass: int(s.biomass),
    runs: int(s.runs),
    wins: int(s.wins),
    best_infected: int(s.best_infected),
    best_depth: int(s.best_depth),
    has_run: brief !== null,
    run: brief,
  };
}

// ─────────────────────────── 引擎 ───────────────────────────

const UNIT_FIELDS = ["uid", "side", "kind", "x", "y", "hp", "max_hp", "atk", "rng",
                     "sight", "shield", "acted", "skill_used", "aim", "aim_uid", "bound",
                     "lvl", "mother", "size"];

class Game {
  constructor() {
    this.rng = new RNG(12345);
    this.grid = [];
    this.units = [];
    this.cocoons = [];
    this.next_id = 1;
    this.turn = 1;
    this.ap = 5;
    this.ap_max = 5;
    this.diff = "normal";
    this.cfg = DIFFS.normal;
    this.mother_kind = "brood";
    this.mother_cd = 0;
    this.map_i = 0;
    this.layer_i = 0;
    this.map_cfg = MAPS[0];
    this.stage_clear = false;
    this.layers_done = 0;
    this.seen = new Set();
    this.visible = new Set();
    this.log = [];
    this.over = false;
    this.result = "";
    this.abandoned = false;
    this.infected = 0;
    this.biomass = 0;
    this.gained = 0;
    this.settled = false;
    this.unlocked = START_UNLOCKED.slice();
    this.buff_view = false;
    this.pending_seed = null;
    this.pending = null;
    this.events = [];
    this.seed = 0;
    this.relics = [];          // 已收藏的感染物 id 列表
    this.relic_drops = [];     // 地图上散落的感染物 [{x,y,id,life}]
    this._pairLog = [];        // 已经播报过连携的 pair id（避免重复刷日志）
    this.mother_lvl = 1;       // 母巢等级（母体单位等级）
    this.mother_exp = 0;       // 当前等级内已积累的经验
    this._rxc = null;          // 感染物加成缓存
    this.mutation = null;      // 突变层：{options, bought, next, from, depth}
    this.last_mutation_depth = -999;   // 上一次突变发生在多深，用来限制连出
  }

  get depth() { return this.map_i * LAYERS_PER_MAP + this.layer_i; }

  _ap_cap(turn) {
    const t = turn === undefined ? this.turn : turn;
    const base = this.cfg.ap + Math.floor(this.depth / AP_PER_DEPTH);
    return base + Math.min(AP_GROW_MAX, Math.floor((t - 1) / AP_GROW_EVERY));
  }

  map_name() { return this.map_cfg.name || "废土"; }
  where() { return `${this.map_name()} ${this.map_i + 1}-${this.layer_i + 1}`; }

  _refresh_ap_max() {
    if (this.tut_i != null) { this.ap_max = TUT_LEVELS[this.tut_i].ap; return; }
    this.ap_max = this._ap_cap() + (this.buff_view ? 1 : 0) + this.rx().apmax;
  }

  /** 感染物加成汇总（带缓存，获得新感染物时置空） */
  rx() {
    if (!this._rxc) this._rxc = relicBonus(this.relics);
    return this._rxc;
  }

  /** 孵化/感染出的丧尸初始等级 = 1 + 母巢等级奖励 + 蛹衣 */
  hatch_level() {
    const fromLvl = Math.floor(this.mother_lvl / HATCH_LVL_EVERY);
    return clamp(1 + fromLvl + this.rx().hatch, 1, MAX_LVL);
  }

  _ev(o) { this.events.push(o); }

  _look(u) {
    if (u.mother) {
      const b = MOTHERS[u.kind.split(":")[1]] || MOTHERS.brood;
      return { short: b.short || "母", color: b.color || "#888" };
    }
    const b = u.side === "z" ? ZTYPES[u.kind] : HTYPES[u.kind];
    return { short: (b && b.short) || "?", color: (b && b.color) || "#888" };
  }

  // ── 对局存档（"继续游戏"）──────────────────────────────
  dump_run() {
    if (this.over || !this.grid.length) return null;
    return {
      seed: int(this.seed),
      diff: this.diff,
      mother: this.mother_kind,
      map_i: this.map_i, layer_i: this.layer_i,
      stage_clear: this.stage_clear, layers_done: this.layers_done,
      turn: this.turn, ap: this.ap, ap_max: this.ap_max,
      mother_cd: this.mother_cd, buff_view: this.buff_view,
      grid: this.grid.map((r) => r.slice()),
      units: this.units.map((u) => {
        const o = {};
        for (const f of UNIT_FIELDS) o[f] = u[f];
        return o;
      }),
      cocoons: this.cocoons.map((c) => Object.assign({}, c)),
      pending: this.pending ? Object.assign({}, this.pending) : null,
      next_id: this.next_id,
      seen: Array.from(this.seen).map((k) => k.split(",").map(Number)),
      log: this.log.slice(-60),
      infected: this.infected,
      biomass: this.biomass,
      unlocked: this.unlocked.slice(),
      relics: this.relics.slice(),
      relic_drops: this.relic_drops.map((r) => Object.assign({}, r)),
      pair_log: this._pairLog.slice(),
      mother_lvl: this.mother_lvl,
      mother_exp: this.mother_exp,
      mutation: this.mutation ? JSON.parse(JSON.stringify(this.mutation)) : null,
      last_mutation_depth: int(this.last_mutation_depth),
      rng: this.rng.getState(),
    };
  }

  restore_run(d) {
    try {
      this.tut_i = null;        // 存档只会是远征，绝不可能是教程
      this.tut_done = false;
      this.tut_flags = { moved: false, skilled: false, hatched: false, relic: false };
      this.rng = new RNG(1);
      this.rng.setState(d.rng);
      this.seed = int(d.seed);
      this.diff = has(DIFFS, d.diff) ? d.diff : "normal";
      this.cfg = DIFFS[this.diff];
      this.mother_kind = has(MOTHERS, d.mother) ? d.mother : "brood";
      this.map_i = clamp(int(d.map_i), 0, MAPS_PER_RUN - 1);
      this.layer_i = clamp(int(d.layer_i), 0, LAYERS_PER_MAP - 1);
      this.map_cfg = MAPS[Math.min(this.map_i, MAPS.length - 1)];
      this.stage_clear = !!d.stage_clear;
      this.layers_done = d.layers_done === undefined ? this.depth : int(d.layers_done);
      this.grid = d.grid.map((r) => r.map(int));
      if (this.grid.length !== H || this.grid.some((r) => r.length !== W)) {
        throw new Error("地图尺寸不符");
      }
      this.units = d.units.map((u) => {
        const o = { shield: 0, acted: 0, skill_used: false, aim: 0, aim_uid: 0, bound: 0, lvl: 1, mother: false };
        for (const f of UNIT_FIELDS) if (u[f] !== undefined) o[f] = u[f];
        return o;
      });
      this.cocoons = (d.cocoons || []).map((c) => Object.assign({}, c));
      this.pending = d.pending ? Object.assign({}, d.pending) : null;
      this.next_id = int(d.next_id);
      this.turn = int(d.turn);
      this.mother_cd = int(d.mother_cd);
      this.buff_view = !!d.buff_view;
      this._refresh_ap_max();
      this.ap = Math.min(int(d.ap), this.ap_max);
      this.seen = new Set((d.seen || []).map((p) => key(int(p[0]), int(p[1]))));
      this.visible = new Set();
      this.log = (d.log || []).slice();
      this.infected = int(d.infected);
      this.biomass = int(d.biomass);
      this.relics = (d.relics || []).filter((k) => has(RELICS, k));
      this.relic_drops = (d.relic_drops || []).filter((r) => has(RELICS, r.id))
        .map((r) => ({ x: int(r.x), y: int(r.y), id: r.id, life: int(r.life) }));
      this._pairLog = (d.pair_log || []).filter((p) => PAIRS.some((x) => x.id === p));
      this.mother_lvl = Math.max(1, int(d.mother_lvl) || 1);
      this.mother_exp = Math.max(0, int(d.mother_exp));
      this.mutation = d.mutation && Array.isArray(d.mutation.options)
        ? JSON.parse(JSON.stringify(d.mutation)) : null;
      this.last_mutation_depth = d.last_mutation_depth === undefined
        ? -999 : int(d.last_mutation_depth);
      this._rxc = null;
      this.gained = 0;
      this.settled = false;
      this.over = false;
      this.result = "";
      this.abandoned = false;
      // 解锁进度跟着存档走（母巢等级决定），不再读局外档案
      this.unlocked = Array.from(new Set((d.unlocked || START_UNLOCKED)
        .filter((k) => has(ZTYPES, k)).concat(START_UNLOCKED))).sort();
      this.events = [];
      this._recompute_vision();
      this._say(`※ 已读取存档，从第 ${this.turn} 回合继续。`);
      return true;
    } catch (e) {
      return false;
    }
  }

  autosave() {
    if (this.tut_i != null) return;     // 教程不写档
    const s = loadSave();
    s.run = this.dump_run();
    writeSave(s);
  }

  new_game(opts) {
    opts = opts || {};
    let seed = opts.seed;
    seed = (seed === null || seed === undefined || seed === "") ? Math.floor(Math.random() * 999999998) + 1 : int(seed);
    if (!(seed > 0)) seed = Math.floor(Math.random() * 999999998) + 1;
    this.rng = new RNG(seed);
    this.seed = seed;
    this.diff = has(DIFFS, opts.diff) ? opts.diff : "normal";
    this.cfg = DIFFS[this.diff];
    this.mother_kind = has(MOTHERS, opts.mother) ? opts.mother : "brood";
    this.map_i = 0;
    this.layer_i = 0;
    this.map_cfg = MAPS[0];
    this.stage_clear = false;
    this.layers_done = 0;
    this.buff_view = false;
    this.units = [];
    this.cocoons = [];
    this.pending = null;
    this.next_id = 1;
    this.log = [];
    this.over = false;
    this.result = "";
    this.abandoned = false;
    this.infected = 0;
    this.biomass = 0;
    this.gained = 0;
    this.settled = false;
    // 局外不再卖丧尸：开局只有三种基础形态，其余靠母巢升级分化
    this.unlocked = START_UNLOCKED.slice();
    this.mother_cd = 0;
    this.seen = new Set();
    this.visible = new Set();
    this.events = [];
    this.relics = [];
    this.relic_drops = [];
    this._pairLog = [];
    this.mother_lvl = 1;
    this.mother_exp = 0;
    this.mutation = null;
    this.last_mutation_depth = -999;
    this._rxc = null;
    this.tut_i = null;          // 非 null = 正在打新手教程的第 N 课
    this.tut_done = false;
    this.tut_flags = { moved: false, skilled: false, hatched: false, relic: false };

    // 新手教程：走固定小关，不进远征、不写存档
    if (opts.tut !== undefined && opts.tut !== null && opts.tut !== false) {
      this.tut_i = clamp(int(opts.tut) || 0, 0, TUT_LEVELS.length - 1);
      this.mother_kind = "brood";     // 教程统一用巢母，好讲「孵化」
      this.diff = "easy";
      this.cfg = Object.assign({}, DIFFS.easy, { turns: 999, spawn_every: 999, spawn_n: 0 });
      this._enter_tut();
      return this.snapshot();
    }

    this._enter_layer(null);
    this._say(`【${this.cfg.label}】种子 ${seed}　母体：${MOTHERS[this.mother_kind].name}`);
    this._say(`目标：走穿 ${MAPS_PER_RUN} 张地图、共 ${RUN_LAYERS} 层。` +
              `每层撑过 ${this.cfg.turns} 回合即下潜，母体倒下即失败。`);
    if (opts.persist !== false) this.autosave();
    return this.snapshot();
  }

  // ── 新手教程：铺一节固定小课（keep = 上一课带过来的我方单位）──
  _enter_tut(keep) {
    const L = TUT_LEVELS[this.tut_i];
    const carry = Array.isArray(keep) ? keep : [];
    const prevSeen = carry.length ? new Set(this.seen) : new Set();
    const prevCocoons = carry.length ? this.cocoons.slice() : [];

    this.turn = 1;
    this.stage_clear = false;
    this.buff_view = false;
    this.mother_cd = 0;
    this.cocoons = L.clearCocoons ? [] : prevCocoons;
    this.pending = null;
    this.seen = prevSeen;
    this.visible = new Set();
    this.events = [];
    this.relic_drops = [];
    this.units = [];
    this.next_id = carry.length
      ? Math.max(...carry.map((u) => int(u.uid) || 0)) + 1 : 1;
    this.infected = 0;
    this.biomass = 0;
    this.gained = 0;
    this.settled = false;
    this.over = false;
    this.result = "";
    this.abandoned = false;
    this.relics = [];
    this._pairLog = [];
    this._rxc = null;
    this.mother_lvl = 1;
    this.mother_exp = 0;
    this.tut_done = false;
    this.tut_flags = { moved: false, skilled: false, hatched: false, relic: false };
    this.unlocked = ["scent", "ripper", "spitter", "bloat"];
    this.map_i = 0;
    this.layer_i = 0;
    this.map_cfg = { name: "新手教程", sub: "" };
    this.layers_done = 0;

    const ch = (c) => c === "#" ? WALL : c === "," ? RUBBLE : c === "~" ? WATER : STREET;
    this.grid = L.map.map((row) => row.split("").map(ch));
    this.mother_cell = L.mother.slice();

    const mt = MOTHERS[this.mother_kind];
    const carriedMother = carry.find((u) => u.mother) || null;
    if (carriedMother) {
      // 母巢固定在每课同一个位置；血量/等级沿用
      carriedMother.x = L.mother[0];
      carriedMother.y = L.mother[1];
      carriedMother.shield = 0; carriedMother.acted = 0; carriedMother.skill_used = false;
      carriedMother.aim = 0; carriedMother.aim_uid = 0; carriedMother.bound = 0;
      this.units.push(carriedMother);
    } else {
      this._add("z", "mother:" + this.mother_kind, L.mother[0], L.mother[1],
                { hp: mt.hp, atk: 0, rng: 0, sight: 7, mother: true });
    }
    const mother = this.units.find((u) => u.mother) || null;

    // 上一课的丧尸原样留在原地；位置被新地图挡住/被占时才就近挪
    for (const u of carry) {
      if (u.mother || u.hp <= 0) continue;
      let px = u.x, py = u.y;
      if (!this._free(px, py)) {
        const spot = this._nearestFreeCell(px, py) ||
          (mother ? this._spawn_spot(mother, 3) : null);
        if (!spot) continue;
        px = spot[0]; py = spot[1];
      }
      u.x = px; u.y = py;
      u.shield = 0; u.acted = 0; u.skill_used = false;
      u.aim = 0; u.aim_uid = 0; u.bound = 0;
      this.units.push(u);
    }

    // 这一课需要、但队伍里没有的丧尸：按关卡坐标生成，位置被占就就近找空位
    const haveKind = new Set(this.units
      .filter((u) => u.side === "z" && !u.mother).map((u) => u.kind));
    for (const z of L.zombies) {
      if (haveKind.has(z[0])) continue;
      const spot = this._free(z[1], z[2]) ? [z[1], z[2]]
        : (this._nearestFreeCell(z[1], z[2]) || (mother ? this._spawn_spot(mother, 3) : null));
      if (!spot) continue;
      this._add("z", z[0], spot[0], spot[1], { lvl: z[3] || 1 });
      haveKind.add(z[0]);
    }

    for (const h of L.humans) {
      const spot = this._free(h[1], h[2]) ? [h[1], h[2]] : this._nearestFreeCell(h[1], h[2]);
      if (spot) this._add("h", h[0], spot[0], spot[1]);
    }
    if (L.relic) {
      const [rid, rx, ry] = L.relic;
      const spot = this._free(rx, ry) ? [rx, ry] : this._nearestFreeCell(rx, ry);
      if (spot) this.relic_drops.push({ x: spot[0], y: spot[1], id: rid, life: 99 });
    }

    if (L.cocoon) {
      const [cx, cy] = L.cocoon;
      const spot = this._free(cx, cy) ? [cx, cy] : this._nearestFreeCell(cx, cy);
      if (spot && !this.cocoons.some((c) => c.x === spot[0] && c.y === spot[1])) {
        this.cocoons.push({ x: spot[0], y: spot[1], life: 99 });
      }
    }

    // 只保留落在可通行格上的旧尸茧
    this.cocoons = this.cocoons.filter((c) =>
      c.life > 0 && this.grid[c.y] && this.grid[c.y][c.x] !== WALL);

    this.ap_max = L.ap;
    this.ap = this.ap_max;
    this._recompute_vision();
    this._say(`【${L.name}】${L.goalText}`);
    this._say(L.hint);
  }

  /** 教程翻到下一课：保留现有丧尸的位置与血量，再铺下一课的新元素。 */
  _act_tut_next() {
    if (this.tut_i == null) throw new ActError("当前不在教程里");
    if (!this.tut_done) throw new ActError("先完成这一课");
    if (this.tut_i >= TUT_LEVELS.length - 1) throw new ActError("已经是最后一课");
    const keep = this.units
      .filter((u) => u.side === "z" && u.hp > 0)
      .map((u) => Object.assign({}, u));
    if (!keep.some((u) => u.mother)) throw new ActError("母巢已经倒下了");
    this.tut_i += 1;
    this._enter_tut(keep);
  }


  // 教程目标判定：任何一次成功的指令之后都要过一遍
  _tut_check() {
    if (this.tut_i == null || this.tut_done) return;
    const L = TUT_LEVELS[this.tut_i];
    const ok =
      L.goal === "move" ? this.tut_flags.moved :
      L.goal === "kill" ? this.infected >= 1 :
      L.goal === "hatch" ? this.tut_flags.hatched :
      L.goal === "evolve" ? this.units.some((u) => u.side === "z" && !u.mother && u.lvl >= 2) :
      L.goal === "mother" ? this.tut_flags.skilled :
      L.goal === "relic" ? this.tut_flags.relic : false;
    if (!ok) return;
    this.tut_done = true;
    this._say(`✓ 完成：${L.goalText}。`);
  }

  // ── 层：生成战场、继承队伍 ───────────────────────────
  _enter_layer(carry) {
    this.turn = 1;
    this.stage_clear = false;
    this.buff_view = false;
    this.mother_cd = 0;
    this.cocoons = [];
    this.pending = null;
    this.seen = new Set();
    this.visible = new Set();
    this.events = [];
    this.relic_drops = [];      // 地图上散落的感染物每层重刷；已收藏的保留
    const keep = (carry || []).slice();
    for (const u of keep) {
      u.acted = 0; u.skill_used = false; u.shield = 0; u.aim = 0; u.bound = 0;
    }
    this.units = [];
    this._gen_map();
    this._place_units(keep);
    this._refresh_ap_max();
    this.ap = this.ap_max;
    this._recompute_vision();
  }

  // ── 地图生成 ─────────────────────────────────────────
  _gen_map() {
    let best = null, bestWalk = -1;
    for (let i = 0; i < 24; i++) {
      const g = this._gen_map_once();
      const m = this._mother_cell(g);
      if (!m) continue;
      const cnt = this._bfs(g, m).list.length;
      if (cnt > bestWalk) { best = g; bestWalk = cnt; }
      if (cnt >= W * H * 0.55) break;
    }
    if (!best) best = this._gen_map_once();
    const g = best;
    let m = this._mother_cell(g);
    if (!m) {   // 极罕见的兜底：整图找一个 2×2 空地，否则整张图会被判成墙
      for (let y = H - 2; y >= 0 && !m; y--) {
        for (let x = 0; x < W - 1; x++) {
          let ok = true;
          for (let dy = 0; dy < MOTHER_SIZE && ok; dy++) {
            for (let dx = 0; dx < MOTHER_SIZE; dx++) {
              if (g[y + dy][x + dx] === WALL) { ok = false; break; }
            }
          }
          if (ok) { m = [x, y]; break; }
        }
      }
    }
    const reach = m ? this._bfs(g, m).set : new Set();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (g[y][x] !== WALL && !reach.has(key(x, y))) g[y][x] = WALL;
      }
    }
    this.grid = g;
    this.mother_cell = m;
  }

  _gen_map_once() {
    const cfg = this.map_cfg;
    const g = [];
    for (let y = 0; y < H; y++) g.push(new Array(W).fill(STREET));

    const xs = [[1, 6], [8, 14], [16, 22]];
    const ys = [[1, 6], [8, 14]];
    const blocks = [];
    for (const bx of xs) for (const by of ys) blocks.push([bx[0], by[0], bx[1], by[1]]);

    const dense = cfg.walls === undefined ? 1.0 : cfg.walls;
    for (const [x0, y0, x1, y1] of blocks) {
      const times = Math.max(1, pyRound(this.rng.randint(1, 3) * dense));
      for (let n = 0; n < times; n++) {
        const bw = this.rng.randint(2, Math.max(2, (x1 - x0) - 1));
        const bh = this.rng.randint(2, Math.max(2, (y1 - y0) - 1));
        const px = this.rng.randint(x0, Math.max(x0, x1 - bw));
        const py = this.rng.randint(y0, Math.max(y0, y1 - bh));
        for (let yy = py; yy < Math.min(H, py + bh); yy++) {
          for (let xx = px; xx < Math.min(W, px + bw); xx++) g[yy][xx] = WALL;
        }
      }
    }
    const rub = cfg.rubble === undefined ? 70 : int(cfg.rubble);
    for (let i = 0; i < rub; i++) {
      const x = this.rng.randrange(0, W), y = this.rng.randrange(0, H);
      if (g[y][x] === STREET) g[y][x] = RUBBLE;
    }
    const wat = cfg.water === undefined ? 3 : int(cfg.water);
    for (let i = 0; i < wat; i++) {
      const cx = this.rng.randrange(2, W - 2), cy = this.rng.randrange(2, H - 2);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        if (g[cy + dy][cx + dx] === STREET) g[cy + dy][cx + dx] = WATER;
      }
    }
    // 地图专属地形：成片撒，才有"田 / 林 / 车阵"的样子，而不是彩色噪点
    for (const sp of (cfg.specials || [])) {
      const t = int(sp[0]), n = int(sp[1]) || 0;
      for (let i = 0; i < n; i++) {
        const x = this.rng.randrange(0, W), y = this.rng.randrange(0, H);
        if (!this._plantable(g, x, y)) continue;
        g[y][x] = t;
        const cluster = (t === WHEAT || t === SAND || t === SHOAL) ? 2 : (t === TREE ? 3 : 1);
        for (let c = 0; c < cluster; c++) {
          const [dx, dy] = this.rng.choice(DIRS4);
          const nx = x + dx * (c + 1), ny = y + dy * (c + 1);
          if (this._plantable(g, nx, ny)) g[ny][nx] = t;
        }
      }
    }
    for (let yy = H - 3; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        if (g[yy][xx] === WALL && this.rng.random() < 0.5) g[yy][xx] = STREET;
      }
    }
    // 预留母巢位：下部清出一条 8×2 空地，保证 2×2 的母巢一定放得下
    const mx0 = this.rng.randrange(3, W - 10);
    for (let yy = H - 3; yy < H - 1; yy++) {
      for (let xx = mx0; xx < mx0 + 8; xx++) g[yy][xx] = STREET;
    }
    return g;
  }

  /** 特殊地形只盖在街道/废墟上，墙和水保持原样 */
  _plantable(g, x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const v = g[y][x];
    return v === STREET || v === RUBBLE;
  }

  _mother_cell(g) {
    // 母巢占 2×2，左上角只在下部两行里挑，保证不会越界
    for (let i = 0; i < 300; i++) {
      const x = this.rng.randrange(2, W - 2);
      const y = this.rng.randrange(H - 3, H - 1);
      let ok = true;
      for (let dy = 0; dy < MOTHER_SIZE && ok; dy++) {
        for (let dx = 0; dx < MOTHER_SIZE; dx++) {
          if (g[y + dy][x + dx] !== STREET) { ok = false; break; }
        }
      }
      if (ok) return [x, y];
    }
    return null;
  }

  /** 洪水填充。返回 {list: [[x,y]...], set: Set("x,y")} */
  _bfs(g, start) {
    const set = new Set([key(start[0], start[1])]);
    const list = [start];
    for (let i = 0; i < list.length; i++) {
      const cx = list[i][0], cy = list[i][1];
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (set.has(key(nx, ny)) || g[ny][nx] === WALL) continue;
        set.add(key(nx, ny));
        list.push([nx, ny]);
      }
    }
    return { list: list, set: set };
  }

  // ── 布点 ─────────────────────────────────────────────
  _place_units(carry) {
    carry = (carry || []).slice();
    const mx = this.mother_cell[0], my = this.mother_cell[1];
    const mother = carry.find((u) => u.mother) || null;
    const team = carry.filter((u) => !u.mother);

    if (mother) {
      mother.x = mx; mother.y = my;
      this.units.push(mother);
      const lk = this._look(mother);
      this._ev({ t: "spawn", uid: mother.uid, x: mx, y: my, side: "z", mother: true,
                 short: lk.short, color: lk.color });
    } else {
      const mt = MOTHERS[this.mother_kind];
      this._add("z", "mother:" + this.mother_kind, mx, my,
                { hp: mt.hp, atk: 0, rng: 0, sight: 5, mother: true });
    }

    const spots = this._bfs(this.grid, [mx, my]).list.filter(
      ([x, y]) => distp(x, y, mx, my) > 0 && distp(x, y, mx, my) <= 4 && this._free(x, y));
    this.rng.shuffle(spots);

    const drop = (u) => {
      while (spots.length) {
        const [x, y] = spots.pop();
        if (this._free(x, y)) {
          u.x = x; u.y = y;
          this.units.push(u);
          const lk = this._look(u);
          this._ev({ t: "spawn", uid: u.uid, x: x, y: y, side: "z", mother: false,
                     short: lk.short, color: lk.color });
          return true;
        }
      }
      return false;
    };
    for (const u of team) drop(u);

    if (!carry.length) {
      const seq = ["ripper", "scent"];
      const pool = this.unlocked.filter((k) => seq.indexOf(k) < 0);
      while (seq.length < this.cfg.start_z) seq.push(pool.length ? this.rng.choice(pool) : "ripper");
      for (let i = 0; i < this.cfg.start_z; i++) {
        const kind = seq[i % seq.length];
        if (spots.length) {
          const [x, y] = spots.pop();
          this._add("z", kind, x, y);
        }
      }
    }

    const n_h = this.cfg.start_h + Math.floor(this.depth / H_COUNT_PER_DEPTH);
    const reach = this._bfs(this.grid, [mx, my]).list.slice();
    const far = reach.filter(([x, y]) => distp(x, y, mx, my) >= 6 && this._free(x, y));
    this.rng.shuffle(far);
    for (let i = 0; i < n_h; i++) {
      if (!far.length) break;
      const [x, y] = far.pop();
      this._add("h", this._pick_human_kind(), x, y);
    }
  }

  _pick_human_kind() {
    const t = this.turn + this.depth * 4;
    let pool = ["civilian", "civilian", "civilian", "civilian", "officer"];
    if (t >= 4) pool = pool.concat(["officer", "shield"]);
    if (t >= 7) pool = pool.concat(["brawler", "shield"]);
    if (t >= 9) pool = pool.concat(["soldier", "medic", "brawler"]);
    if (t >= 12) pool = pool.concat(["sniper", "soldier"]);
    let k = this.rng.choice(pool);
    if (k === "civilian") {
      const r = this.rng.random();
      const mil = this.map_cfg.military || 0;
      const pol = this.map_cfg.police || 0;
      if (r < mil) k = this.rng.random() < 0.7 ? "soldier" : "shield";
      else if (r < mil + pol) k = this.rng.random() < 0.7 ? "officer" : "brawler";
    }
    return k;
  }

  _add(side, kind, x, y, opt) {
    opt = opt || {};
    let st;
    if (opt.mother) {
      const base = MOTHERS[kind.split(":")[1]];
      st = { hp: base.hp, atk: base.atk, rng: 0, sight: 5 };
    } else if (side === "z") {
      st = zstats(kind, opt.lvl === undefined ? 1 : opt.lvl);
      const b = this.rx();     // 感染物加成：对之后诞生的丧尸同样生效
      st.hp += b.hp;
      st.atk += b.atk;
      st.sight += b.sight;
      if (st.rng >= 2) st.rng += b.rng;   // 只给本来就远程的单位加射程，近战不变
    } else {
      const base = HTYPES[kind];
      const d = this.depth;
      st = {
        hp: base.hp + Math.floor(d / H_HP_PER_DEPTH),
        atk: base.atk + Math.floor(d / H_ATK_PER_DEPTH),
        rng: base.rng,
        sight: base.sight,
      };
    }
    const u = {
      uid: this.next_id, side: side, kind: kind, x: x, y: y,
      hp: opt.hp !== undefined ? opt.hp : st.hp,
      max_hp: opt.hp !== undefined ? opt.hp : st.hp,
      atk: opt.atk !== undefined ? opt.atk : st.atk,
      rng: opt.rng !== undefined ? opt.rng : (st.rng === undefined ? 1 : st.rng),
      sight: opt.sight !== undefined ? opt.sight : (st.sight === undefined ? 3 : st.sight),
      shield: 0, acted: 0, skill_used: false, aim: 0, aim_uid: 0, bound: 0,
      lvl: side === "z" && !opt.mother ? (opt.lvl === undefined ? 1 : opt.lvl) : 1,
      mother: !!opt.mother,
      size: opt.mother ? MOTHER_SIZE : 1,
    };
    this.next_id += 1;
    this.units.push(u);
    const lk = this._look(u);
    this._ev({ t: "spawn", uid: u.uid, x: x, y: y, side: side, mother: !!opt.mother,
               short: lk.short, color: lk.color });
    return u;
  }

  // ── 查询工具 ─────────────────────────────────────────
  _free(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (this.grid[y][x] === WALL) return false;
    return this.unit_at(x, y) === null;
  }

  unit_at(x, y) {
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      if (u.size === MOTHER_SIZE) {
        if (x >= u.x && x < u.x + MOTHER_SIZE && y >= u.y && y < u.y + MOTHER_SIZE) return u;
      } else if (u.x === x && u.y === y) return u;
    }
    return null;
  }

  /** 单位占据的格子（母巢 4 格，其余 1 格） */
  cells(u) {
    if (u.size !== MOTHER_SIZE) return [[u.x, u.y]];
    const out = [];
    for (let dy = 0; dy < MOTHER_SIZE; dy++) {
      for (let dx = 0; dx < MOTHER_SIZE; dx++) out.push([u.x + dx, u.y + dy]);
    }
    return out;
  }

  /** 到目标"身体"的距离：母巢按最近的格子算，否则就是点到点 */
  unitDist(a, b) {
    if (b.size !== MOTHER_SIZE) return dist(a, b);
    let m = Infinity;
    for (const c of this.cells(b)) m = Math.min(m, distp(a.x, a.y, c[0], c[1]));
    return m;
  }

  by_id(uid) {
    for (const u of this.units) if (u.uid === uid) return u;
    return null;
  }

  los(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;
    while (!(x === x1 && y === y1)) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) break;
      if (blocksLOS(this.grid[y][x])) return false;
    }
    return true;
  }

  disc(cx, cy, r) {
    const out = [];
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        if (distp(x, y, cx, cy) <= r + 0.01) out.push([x, y]);
      }
    }
    return out;
  }

  _recompute_vision() {
    const vis = new Set();
    for (const u of this.units) {
      if (u.side !== "z" || u.hp <= 0) continue;
      const r = u.sight * (this.buff_view ? 2 : 1);
      for (const [x, y] of this.disc(u.x, u.y, r)) {
        if (this.los(u.x, u.y, x, y)) vis.add(key(x, y));
      }
    }
    this.visible = vis;
    for (const k of vis) this.seen.add(k);
  }

  // ── 移动可达（Dijkstra）───────────────────────────────
  reachable(u, budget) {
    const start = key(u.x, u.y);
    const dist = new Map([[start, 0]]);
    const prev = new Map();
    const pq = new Heap();
    pq.push(0, start);
    while (pq.size) {
      const top = pq.pop();
      const d = top[0], k = top[1];
      if (d > (dist.has(k) ? dist.get(k) : Infinity)) continue;
      const p = k.split(",");
      const cx = +p[0], cy = +p[1];
      for (const [dx, dy] of DIRS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const t = this.grid[ny][nx];
        if (t === WALL || this.unit_at(nx, ny)) continue;
        const nd = d + WALK_COST[t];
        if (nd > budget) continue;
        const nk = key(nx, ny);
        if (nd < (dist.has(nk) ? dist.get(nk) : Infinity)) {
          dist.set(nk, nd);
          prev.set(nk, k);
          pq.push(nd, nk);
        }
      }
    }
    return { dist: dist, prev: prev };
  }

  _path_to(u, tx, ty) {
    const r = this.reachable(u, this.ap);
    const tk = key(tx, ty);
    if (!r.dist.has(tk)) return null;
    const path = [[tx, ty]];
    let cur = tk;
    const sk = key(u.x, u.y);
    let guard = 0;
    while (cur !== sk) {
      cur = r.prev.get(cur);
      if (cur === undefined || guard++ > 2000) return null;
      const p = cur.split(",");
      path.push([+p[0], +p[1]]);
    }
    return [path.reverse(), r.dist.get(tk)];
  }

  // ── 伤害 ─────────────────────────────────────────────
  _damage(tgt, dmg, who, src) {
    const ox = tgt.x, oy = tgt.y;
    const pierce = !!(src && src.side === "z" && this.rx().pierce > 0);
    const cover = coverAt(this.grid[tgt.y][tgt.x]);
    if (cover > 0 && !pierce) dmg = Math.max(1, dmg - cover);
    if (tgt.shield > 0) {
      const ab = Math.min(tgt.shield, dmg);
      tgt.shield -= ab;
      dmg -= ab;
    }
    if (dmg > 0) tgt.hp -= dmg;
    const dead = tgt.hp <= 0;
    if (dead) this._on_death(tgt, who || "", src);
    const look = this._look(tgt);
    this._ev({ t: "dmg", uid: tgt.uid,
               sx: src ? src.x : ox, sy: src ? src.y : oy,
               tx: ox, ty: oy, dmg: dmg, side: tgt.side, dead: dead,
               mother: tgt.mother, short: look.short, color: look.color,
               melee: !!(src && src.rng <= 1) });
    return dmg;
  }

  _on_death(u, who, src) {
    if (u.mother) {
      this.over = true;
      this.result = "lose";
      this._say("※ 母体崩解。本局失败。");
      return;
    }
    if (u.side === "z") {
      this._say(`${ZTYPES[u.kind].name} 彻底倒下。`);
    } else {
      const b = this.rx();
      this.infected += 1;
      this.biomass += 1 + b.bio;
      this.cocoons.push({ x: u.x, y: u.y, life: COCOON_LIFE + b.cocoon });
      // 击杀者吸血
      if (b.leech && src && src.side === "z" && src.hp > 0) {
        src.hp = Math.min(src.max_hp, src.hp + b.leech);
      }
      // 狂化腺：击杀返还腐能
      if (b.frenzy && src && src.side === "z") {
        this.ap = Math.min(this.ap_max, this.ap + b.frenzy);
      }
      this._say(`${HTYPES[u.kind].name} 被击杀，原地留下【尸茧】与 1 生物质。`);
      // 母巢吃经验（腺体增生 / 瘟疫之肺会加码）
      this._gain_exp((EXP_KILL[u.kind] || 1) + b.expk);
    }
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
  }

  // ── 母巢等级 ─────────────────────────────────────────
  _gain_exp(n) {
    if (!n || n < 0) return;
    this.mother_exp += n;
    this._check_levelup();
  }

  _check_levelup() {
    let guard = 0;
    while (this.mother_exp >= expNeed(this.mother_lvl) && guard++ < 40) {
      this.mother_exp -= expNeed(this.mother_lvl);
      this.mother_lvl += 1;
      const mm = this.units.find((u) => u.mother);
      if (mm) { mm.max_hp += 2; mm.hp += 2; }   // 母巢本身也跟着长大
      this._say(`※ 母巢升至 Lv${this.mother_lvl}，产出一枚感染物。`);
      this._grant_relic();
      // 局内解锁：母巢分化出新器官，尸茧里才能孵出这种丧尸
      for (const k of Object.keys(ZTYPES)) {
        if ((ZTYPES[k].unlock_lvl || 0) !== this.mother_lvl) continue;
        if (this.unlocked.indexOf(k) >= 0) continue;
        this.unlocked.push(k);
        this.unlocked.sort();
        this._say(`※ 母巢分化出新的器官：解锁【${ZTYPES[k].name}】，尸茧里可以孵出来了。`);
      }
      if (this.mother_lvl % HATCH_LVL_EVERY === 0) {
        this._say(`※ 母巢 Lv${this.mother_lvl}：之后孵化出的丧尸初始等级提高到 Lv${this.hatch_level()}。`);
      }
    }
  }

  /** 母巢升级直接产出一枚感染物（按稀有度抽，深度不够只出低阶） */
  _grant_relic() {
    const id = rollRelic(this.rng, this.depth, this.relics);
    if (!id) {
      this.biomass += 3;
      this._say("感染物已集齐，这一枚化为 3 生物质。");
      return null;
    }
    this.relics.push(id);
    this._rxc = null;
    this._apply_fx(RELICS[id].fx);
    const rr = RARITY[RELICS[id].r];
    this._say(`获得【${rr.name}】感染物【${RELICS[id].name}】：${RELICS[id].desc}`);
    this._check_pairs();
    return id;
  }

  /** 新凑成的连携要播报一次（效果本身由 relicBonus 自动计入） */
  _check_pairs() {
    for (const p of PAIRS) {
      if (this._pairLog.indexOf(p.id) >= 0) continue;
      if (!p.need.every((k) => this.relics.indexOf(k) >= 0)) continue;
      this._pairLog.push(p.id);
      this._say(`※ 连携成立【${p.name}】：${p.desc}`);
      this._ev({ t: "pair", id: p.id, name: p.name });
    }
  }

  /** 立刻把一组属性加成落到场上现有的丧尸身上（机制类效果是实时读 rx()，不用落） */
  _apply_fx(f) {
    if (!f) return;
    for (const u of this.units) {
      if (u.side !== "z") continue;
      if (f.atk && !u.mother) u.atk += f.atk;
      if (f.sight) u.sight += f.sight;
      if (f.rng && !u.mother && u.rng >= 2) u.rng += f.rng;
      if (f.hp && !u.mother) { u.max_hp += f.hp; u.hp += f.hp; }
    }
    if (f.girth) {
      const m = this.units.find((u) => u.mother);
      if (m) { m.max_hp += f.girth; m.hp += f.girth; }
    }
    if (f.apmax) this._refresh_ap_max();
  }

  _maybe_relic_drop() {
    if (this.tut_i != null) return;
    if (this.rng.random() >= RELIC_DROP_CHANCE) return;
    const m = this.units.find((u) => u.mother);
    if (!m) return;
    // 地上还没被捡的也算"已有"，避免同一件重复刷两枚
    const busy = this.relic_drops.map((r) => r.id);
    const id = rollRelic(this.rng, this.depth, this.relics.concat(busy));
    if (!id) return;
    const spots = this._bfs(this.grid, [m.x, m.y]).list.filter(
      ([x, y]) => this._free(x, y) && !this.cocoons.some((c) => c.x === x && c.y === y));
    if (!spots.length) return;
    const c = this.rng.choice(spots);
    this.relic_drops.push({ x: c[0], y: c[1], id: id, life: RELIC_LIFE });
    this._say(`废墟里闪了一下：地图上出现了【${RARITY[RELICS[id].r].name}】感染物。`);
  }

  _pickup_relic(u) {
    const d = this.relic_drops.find((r) => r.x === u.x && r.y === u.y);
    if (!d) return;
    this.relic_drops.splice(this.relic_drops.indexOf(d), 1);
    this.relics.push(d.id);
    this._rxc = null;
    if (this.tut_i != null) this.tut_flags.relic = true;
    this._apply_fx(RELICS[d.id].fx);
    this._ev({ t: "relic", uid: u.uid, x: d.x, y: d.y, id: d.id,
               name: RELICS[d.id].name, color: RELICS[d.id].color,
               rarity: RELICS[d.id].r });
    this._say(`${this._uname(u)} 拾获【${RARITY[RELICS[d.id].r].name}】感染物` +
              `【${RELICS[d.id].name}】：${RELICS[d.id].desc}`);
    this._check_pairs();
  }

  _tick_relics() {
    for (const r of this.relic_drops.slice()) {
      r.life -= 1;
      if (r.life <= 0) {
        this.relic_drops.splice(this.relic_drops.indexOf(r), 1);
        this._say(`一枚【${RELICS[r.id].name}】被尘土掩埋了。`);
      }
    }
  }

  _levelup(u, quiet) {
    if (u.side !== "z" || u.mother) throw new ActError("只有丧尸能升级");
    if (u.lvl >= MAX_LVL) throw new ActError(`${ZTYPES[u.kind].name} 已经是满级 Lv${MAX_LVL}`);
    const oldMax = u.max_hp;
    u.lvl += 1;
    const st = zstats(u.kind, u.lvl);
    const b = this.rx();          // 重算时要带上感染物加成，否则会把它抹掉
    u.max_hp = st.hp + b.hp;
    u.atk = st.atk + b.atk;
    u.rng = st.rng + (st.rng >= 2 ? b.rng : 0);
    u.sight = st.sight + b.sight;
    u.hp = Math.min(u.max_hp, u.hp + (u.max_hp - oldMax) + 2);
    if (!quiet) {
      this._say(`【${ZTYPES[u.kind].name}#${u.uid}】吞下尸茧，升至 Lv${u.lvl}` +
                `（HP ${u.max_hp} · 攻 ${u.atk} · 射程 ${u.rng}）。`);
    }
  }

  _free_near(x, y) {
    for (const [dx, dy] of DIRS8_N) if (this._free(x + dx, y + dy)) return [x + dx, y + dy];
    return null;
  }

  /** 从母巢往外一圈圈找空位：2×2 的巢身边常挤满，只看第一圈会一直失败 */
  /** 从 (x,y) 开始按环向外找最近的空格；找不到返回 null。 */
  _nearestFreeCell(x, y) {
    if (this._free(x, y)) return [x, y];
    for (let r = 1; r < Math.max(W, H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this._free(x + dx, y + dy)) return [x + dx, y + dy];
        }
      }
    }
    return null;
  }

  _spawn_spot(m, rmax) {
    for (let r = 1; r <= (rmax || 3); r++) {
      const ring = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this._free(m.x + dx, m.y + dy)) ring.push([m.x + dx, m.y + dy]);
        }
      }
      if (ring.length) return this.rng.choice(ring);
    }
    return null;
  }

  // ── 玩家动作 ─────────────────────────────────────────
  act(payload) {
    payload = payload || {};
    if (this.over) return this.snapshot();
    const t = payload.type;
    if (t === "abandon") {
      this.over = true;
      this.result = "lose";
      this.abandoned = true;
      this._say("※ 你放弃了这场远征。");
    } else if (this.mutation) {
      // 突变层是强制的：先花完/放弃这次机会，才能继续下潜
      if (t === "mutate" || t === "mutation_done") {
        try {
          if (t === "mutate") this._act_mutate(payload);
          else this._act_mutation_done();
        } catch (e) {
          if (e instanceof ActError) this._say("× " + e.message);
          else this._say("× 无法执行该指令");
        }
      } else {
        this._say("× 先处理眼前的突变");
        return this.snapshot();
      }
    } else if (this.stage_clear && t !== "advance") {
      this._say("× 本层已肃清，先继续深入");
      return this.snapshot();
    } else {
      if (t !== "cocoon") this.pending = null;
      try {
        if (t === "move") this._act_move(payload);
        else if (t === "attack") this._act_attack(payload);
        else if (t === "skill") this._act_skill(payload);
        else if (t === "cocoon") this._act_cocoon(payload);
        else if (t === "mother") this._act_mother();
        else if (t === "advance") this._act_advance();
        else if (t === "tut_next") this._act_tut_next();
        else if (t === "end_turn") this._end_turn();
      } catch (e) {
        if (e instanceof ActError) this._say("× " + e.message);
        else this._say("× 无法执行该指令");
      }
    }
    if (this.over && !this.settled) this._settle();
    this._recompute_vision();
    this._tut_check();
    if (this.tut_i == null) this.autosave();   // 教程不进存档
    return this.snapshot();
  }

  _settle() {
    if (this.settled) return;
    this.settled = true;
    if (this.tut_i != null) return;      // 教程不结算、不进档案
    const gain = this.biomass + (this.result === "win" ? WIN_BIOMASS : 0);
    this.gained = gain;
    const s = loadSave();
    s.biomass = int(s.biomass) + gain;
    s.runs = int(s.runs) + 1;
    if (this.result === "win") s.wins = int(s.wins) + 1;
    s.best_infected = Math.max(int(s.best_infected), this.infected);
    s.best_depth = Math.max(int(s.best_depth), this.depth + 1);
    writeSave(s);
    this._say(`── 结算：带入 ${gain} 生物质（累计 ${s.biomass}）──`);
  }

  _mine(uid) {
    const u = this.by_id(uid);
    if (!u || u.side !== "z" || u.hp <= 0) throw new ActError("无效单位");
    return u;
  }

  // 不再限制每只丧尸每回合的行动次数 —— 想动几次动几次，只受腐能约束
  _act_limit() { return 999; }

  _act_move(p) {
    const u = this._mine(p.uid);
    const tx = int(p.x), ty = int(p.y);
    if (tx === u.x && ty === u.y) throw new ActError("已经站在这一格了");
    const r = this._path_to(u, tx, ty);
    if (!r) throw new ActError("无法抵达该格");
    const path = r[0], cost = r[1];
    if (cost > this.ap) throw new ActError(`${AP_NAME}不足（需 ${cost}，剩 ${this.ap}）`);
    this.ap -= cost;
    const fx = u.x, fy = u.y;
    u.x = tx; u.y = ty;
    u.acted += 1;
    const lk = this._look(u);
    this._ev({ t: "move", uid: u.uid, fx: fx, fy: fy, tx: tx, ty: ty,
               path: path, side: "z", mother: u.mother,
               short: lk.short, color: lk.color });
    this._say(`${this._uname(u)} 移动 ${path.length - 1} 格（-${cost} ${AP_NAME}）`);
    if (this.tut_i != null) this.tut_flags.moved = true;
    this._pickup_relic(u);
    this._maybe_cocoon(u);
  }

  _act_attack(p) {
    const u = this._mine(p.uid);
    if (u.atk <= 0) throw new ActError(`${ZTYPES[u.kind].name}没有攻击能力`);
    const t = this.by_id(p.target);
    if (!t || t.hp <= 0 || t.side === "z") throw new ActError("无效目标");
    if (this.ap < ATK_AP) throw new ActError(`${AP_NAME}不足`);
    if (this.unitDist(u, t) > u.rng + 0.01) throw new ActError("目标不在射程内");
    if (!this._losTo(u, t)) throw new ActError("视线被墙体阻挡");
    this.ap -= ATK_AP;
    u.acted += 1;
    const dmg = this._damage(t, u.atk, this._uname(u), u);
    this._say(`${this._uname(u)} 攻击 ${this._hname(t)}，造成 ${dmg} 伤害`);
    // 裂爆囊：近战攻击连带溅射目标周围 1 格
    if (this.rx().splash > 0 && u.rng <= 1) {
      const side = Math.max(1, Math.floor(u.atk / 2));
      let extra = 0;
      for (const [cx, cy] of this.disc(t.x, t.y, 1)) {
        const o = this.unit_at(cx, cy);
        if (o && o !== t && o.side === "h" && o.hp > 0) {
          this._damage(o, side, "裂爆", u);
          extra += 1;
        }
      }
      if (extra) this._say(`裂爆囊炸开，${extra} 名相邻人类各受 ${side} 点伤害。`);
    }
  }

  _act_skill(p) {
    const u = this._mine(p.uid);
    if (u.mother) throw new ActError("母体技能请用独立按钮");
    if (u.skill_used) throw new ActError("该单位本回合技能已用过");
    if (this.ap < SKILL_AP) throw new ActError(`${AP_NAME}不足`);
    const k = u.kind;

    if (k === "scent") {
      const x = int(p.x), y = int(p.y);
      if (x < 0 || y < 0 || x >= W || y >= H) throw new ActError("坐标非法");
      const cells = scentCells(u.lvl, x, y);
      for (const [cx, cy] of cells) this.seen.add(key(cx, cy));
      this._say(`嗅探者扫描 (${x},${y})，撕开 ${cells.length} 格迷雾。`);
    } else if (k === "bulwark") {
      u.shield += 3;
      for (const o of this.units) {
        if (o.side === "z" && o !== u && Math.abs(o.x - u.x) <= 1 && Math.abs(o.y - u.y) <= 1) {
          o.shield += 1;
        }
      }
      this._say("肉垒筑垒，周围友军获得护盾。");
    } else if (k === "ripper") {
      const t = this.by_id(p.target);
      if (!t || t.hp <= 0 || t.side === "z" || dist(u, t) > 1.01) {
        throw new ActError("撕裂需要一个相邻的敌人");
      }
      const dmg = this._damage(t, u.atk * 2, "撕裂者", u);
      u.hp -= 1;
      this._say(`撕裂者双倍撕裂 ${this._hname(t)}，${dmg} 伤害（自损 1）`);
      if (u.hp <= 0) this._on_death(u, "", null);
    } else if (k === "spitter") {
      const t = this.by_id(p.target);
      if (!t || t.hp <= 0 || t.side === "z") throw new ActError("无效目标");
      if (dist(u, t) > u.rng + 0.01 || !this.los(u.x, u.y, t.x, t.y)) {
        throw new ActError("目标不在射程或视线外");
      }
      this._damage(t, Math.max(1, u.atk - 1), "酸蚀", u);
      for (const [cx, cy] of this.disc(t.x, t.y, 1)) {
        const o = this.unit_at(cx, cy);
        if (o && o !== t && o.side === "h") this._damage(o, Math.max(1, u.atk - 2), "酸蚀", u);
      }
      this._say("喷吐者喷出酸液，目标周围被腐蚀。");
    } else if (k === "skitter") {
      u.acted = Math.max(0, u.acted - 1);   // 与下面的 +1 抵消：技能不占行动次数
      this._say("爬行者四肢反折，抢出一步。");
    } else if (k === "bloat") {
      const boom = 5 + 2 * (u.lvl - 1);
      let hits = 0;
      for (const [cx, cy] of this.disc(u.x, u.y, 1)) {
        const o = this.unit_at(cx, cy);
        if (o && o.side === "h") { this._damage(o, boom, "爆裂", u); hits += 1; }
      }
      this._say(`爆裂体当场胀裂！${hits} 名人类被冲击波掀翻（${boom} 伤害）。`);
      this.ap -= SKILL_AP;
      u.skill_used = true;
      this._on_death(u, "", null);
      return;
    } else if (k === "weaver") {
      const t = this.by_id(p.target);
      if (!t || t.hp <= 0 || t.side === "z") throw new ActError("无效目标");
      if (dist(u, t) > u.rng + 0.01 || !this.los(u.x, u.y, t.x, t.y)) {
        throw new ActError("目标不在射程或视线外");
      }
      t.bound = 1;
      this._say(`编织者用菌丝缠住 ${HTYPES[t.kind].name}，它下回合无法移动。`);
    } else if (k === "rotter") {
      // 腐解：把自己整个喂给母巢
      const exp = 8 + 3 * (u.lvl - 1);
      this.ap -= SKILL_AP;
      u.skill_used = true;
      this._say(`催腐者把自己溶成一滩黑水，母巢吞下 ${exp} 点经验。`);
      this._on_death(u, "", null);
      this._gain_exp(exp);
      return;
    }
    this.ap -= SKILL_AP;
    u.acted += 1;
    u.skill_used = true;
  }

  _act_cocoon(p) {
    const choice = p.choice;
    if (choice === "later") {
      this.pending = null;
      this._say("你决定先放着这枚尸茧。");
      return;
    }
    const x = int(p.x === undefined ? -1 : p.x), y = int(p.y === undefined ? -1 : p.y);
    const coc = this.cocoons.find((c) => c.x === x && c.y === y);
    if (!coc) {
      this.pending = null;
      throw new ActError("这里没有尸茧");
    }
    const zhere = this.unit_at(x, y);
    const onPending = this.pending && this.pending.x === x && this.pending.y === y;
    if (!onPending && !(zhere && zhere.side === "z" && !zhere.mother)) {
      throw new ActError("先让一只丧尸走到尸茧上");
    }
    if (choice === "hatch") {
      const kind = p.kind;
      if (!has(ZTYPES, kind)) throw new ActError("未知丧尸类型");
      if (this.unlocked.indexOf(kind) < 0) throw new ActError(`【${ZTYPES[kind].name}】尚未解锁`);
      const slot = this._free_near(x, y);
      if (!slot) throw new ActError("尸茧周围没有空位，先挪开一点");
      this.cocoons.splice(this.cocoons.indexOf(coc), 1);
      const hl = this.hatch_level();
      const u = this._add("z", kind, slot[0], slot[1], { lvl: hl });
      this.pending = null;
      if (this.tut_i != null) this.tut_flags.hatched = true;
      this._say(`尸茧裂开，【${ZTYPES[kind].name}】从里面爬出来（Lv${hl}）。`);
      this._maybe_cocoon(u);
    } else if (choice === "upgrade") {
      const tgt = this.by_id(p.uid);
      if (!tgt || tgt.hp <= 0 || tgt.side !== "z" || tgt.mother) throw new ActError("请选择一只丧尸");
      if (tgt.lvl >= MAX_LVL) throw new ActError("该单位已是满级");
      this.cocoons.splice(this.cocoons.indexOf(coc), 1);
      this.pending = null;
      this._levelup(tgt);
    } else {
      throw new ActError("未知选择");
    }
  }

  _act_mother() {
    if (this.mother_cd > 0) throw new ActError(`母体技能冷却中（${this.mother_cd} 回合）`);
    const m = this.units.find((u) => u.mother);
    if (!m) throw new ActError("母体已不存在");
    const k = this.mother_kind;
    if (k === "brood") {
      const slot = this._spawn_spot(m, 3);
      if (!slot) throw new ActError("母体周围没有空地");
      this._add("z", "ripper", slot[0], slot[1], { lvl: this.hatch_level() });
      this._say("巢母产下一只【撕裂者】。");
    } else if (k === "mycelia") {
      this.buff_view = true;
      this._refresh_ap_max();
      this.ap = Math.min(this.ap_max, this.ap + 1);
      for (const u of this.units) if (u.side === "z") u.acted = Math.max(0, u.acted - 1);
      this._say(`菌丝网络张开：本回合全体视野翻倍、${AP_NAME} +1。`);
    } else if (k === "carapace") {
      for (const u of this.units) {
        if (u.side === "z" && Math.abs(u.x - m.x) <= 2 && Math.abs(u.y - m.y) <= 2) u.shield += 4;
      }
      this._say("磐母张开甲壳，近旁友军获得 4 点护盾。");
    }
    if (this.tut_i != null) this.tut_flags.skilled = true;
    // 神经节：冷却缩短
    this.mother_cd = Math.max(0, MOTHERS[k].cd - this.rx().mind);
  }

  _maybe_cocoon(u) {
    for (const c of this.cocoons) {
      if (c.x === u.x && c.y === u.y) {
        this.pending = { x: u.x, y: u.y, uid: u.uid, life: c.life === undefined ? COCOON_LIFE : c.life };
        this._say(`${this._uname(u)} 踩到一枚尸茧……（等待处置）`);
        return;
      }
    }
  }

  // ── 回合流转 ─────────────────────────────────────────
  _end_turn() {
    // 催腐者的被动：活着的每只每回合喂母巢 1 点经验
    let feed = 0;
    for (const u of this.units) {
      if (u.side === "z" && !u.mother && u.kind === "rotter" && u.hp > 0) feed += EXP_ROTTER;
    }
    if (feed) this._gain_exp(feed);
    this._enemy_phase();
    if (this.over) return;
    this._tick_cocoons();
    this._tick_relics();
    if (this.turn >= this.cfg.turns) {
      this._layer_clear();
      return;
    }
    this.turn += 1;
    this.buff_view = false;
    this._refresh_ap_max();
    this.ap = this.ap_max;
    for (const u of this.units) {
      u.acted = 0; u.skill_used = false; u.shield = 0;
    }
    // 壳质层：每回合开始给全体丧尸上盾
    const ward = this.rx().ward;
    if (ward) for (const u of this.units) if (u.side === "z") u.shield += ward;
    if (this.mother_cd > 0) this.mother_cd -= 1;
    if (this.turn % this.cfg.spawn_every === 0) this._spawn_wave();
    this._maybe_relic_drop();
    // 回响腺：每回合给伤得最重的那只回点血
    const regen = this.rx().regen;
    if (regen) {
      const hurt = this.units.filter((u) => u.side === "z" && !u.mother && u.hp < u.max_hp);
      if (hurt.length) {
        hurt.sort((a, b) => (a.hp / a.max_hp) - (b.hp / b.max_hp));
        const t = hurt[0];
        t.hp = Math.min(t.max_hp, t.hp + regen);
        this._ev({ t: "heal", uid: t.uid, x: t.x, y: t.y, amount: regen,
                   short: "愈", color: "#7ce0c0" });
      }
    }
    // 菌毯：站上去的我方丧尸每回合回 1 血
    for (const u of this.units) {
      if (u.side !== "z" || u.mother || u.hp <= 0 || u.hp >= u.max_hp) continue;
      const h = TERR[this.grid[u.y][u.x]].healZ || 0;
      if (h > 0) {
        u.hp = Math.min(u.max_hp, u.hp + h);
        this._ev({ t: "heal", uid: u.uid, x: u.x, y: u.y, amount: h,
                   short: "毯", color: "#c9a0ff" });
      }
    }
    this._say(`── 第 ${this.turn} 回合 ──　${AP_NAME} ${this.ap}/${this.ap_max}`);
  }

  _layer_clear() {
    this.stage_clear = true;
    this.biomass += LAYER_CLEAR_BIO;
    this.layers_done = this.depth + 1;
    this._say(`※ 撑过 ${this.cfg.turns} 回合，${this.where()} 肃清（+${LAYER_CLEAR_BIO} 生物质）。`);
    this._gain_exp(EXP_LAYER);
    if (this.depth + 1 >= RUN_LAYERS) {
      this._say("这是最后一层……再往前就是这座城市的心脏了。");
    }
  }

  _interlude() {
    for (const u of this.units) {
      if (u.side !== "z") continue;
      if (u.mother) {
        u.max_hp += MOTHER_CLEAR_HP;
        u.hp = u.max_hp;
      } else {
        const old = u.max_hp;
        u.atk += CLEAR_ATK;
        u.max_hp = old + Math.max(1, Math.round(old * CLEAR_HP_PCT));
        u.hp = u.max_hp;
      }
    }
  }

  _act_advance() {
    if (!this.stage_clear) throw new ActError("本层还没肃清，先撑完回合");
    this._interlude();
    this.stage_clear = false;
    const next = this._nextStop();
    if (!next) {
      this.over = true;
      this.result = "win";
      this._say(`※ 打穿 ${MAPS_PER_RUN} 张地图共 ${RUN_LAYERS} 层，整座城市沉入腐潮。` +
                `累计感染 ${this.infected} 人。`);
      return;
    }
    if (this._rollMutation(next)) return;   // 掉进突变层，等玩家花完生物质再下去
    this._goNextStop(next);
  }

  /** 下一站（不真的走）：还有下一层就返回坐标，打完最后一层返回 null。 */
  _nextStop() {
    if (this.layer_i + 1 < LAYERS_PER_MAP) return { map_i: this.map_i, layer_i: this.layer_i + 1 };
    if (this.map_i + 1 < MAPS_PER_RUN) return { map_i: this.map_i + 1, layer_i: 0 };
    return null;
  }

  /** 掷一次突变：两次之间至少隔 MUTATION_GAP 层，命中就挂起等玩家。 */
  _rollMutation(next) {
    if (this.depth - this.last_mutation_depth < MUTATION_GAP) return false;
    if (this.rng.random() >= MUTATION_CHANCE) return false;
    this._beginMutation(next);
    return true;
  }

  _beginMutation(next) {
    this.last_mutation_depth = this.depth;
    this.mutation = {
      options: this._rollMutationOptions(),
      bought: {},
      next: { map_i: next.map_i, layer_i: next.layer_i },
      from: this.where(),
      depth: this.depth,
    };
    this._say(`※ 菌丝在脚边绞紧，【突变】降临（下一站：${MAPS[next.map_i].name}）。`);
  }

  /** 四项里随机抽三项，每项数值/标价都随机；id 用槽位号保证唯一（退化时会出现两个 exp）。 */
  _rollMutationOptions() {
    const pool = ["exp", "relic", "zombie", "upgrade"];
    this.rng.shuffle(pool);
    return pool.slice(0, 3).map((kind, i) =>
      Object.assign(this._buildMutation(kind), { id: "m" + (i + 1) }));
  }

  _buildMutation(id) {
    const d = this.depth;
    const mother = this.units.find((u) => u.mother) || null;
    if (id === "exp") {
      const value = 8 + d * 2 + this.rng.randint(0, 8);
      return { id, kind: "exp", value, cost: MUTATION_COST.exp(value),
               title: "母巢经验", desc: `母巢获得 ${value} 点经验` };
    }
    if (id === "relic") {
      const busy = this.relic_drops.map((r) => r.id);
      const rid = rollRelic(this.rng, d, this.relics.concat(busy));
      if (rid) {
        const r = RELICS[rid].r;
        return { id, kind: "relic", relic: rid, cost: MUTATION_COST.relic(r, d),
                 title: "感染物",
                 desc: `获得【${RARITY[r].name}】${RELICS[rid].name}：${RELICS[rid].desc}` };
      }
      const value = 10 + d * 2;
      return { id: "exp", kind: "exp", value, cost: MUTATION_COST.exp(value),
               title: "母巢经验", desc: `母巢获得 ${value} 点经验` };
    }
    if (id === "zombie") {
      const pool = (this.unlocked || []).filter((k) => k !== "rotter");
      const kind = this.rng.choice(pool.length ? pool : this.unlocked);
      const lvl = this.hatch_level();
      if (mother && this._spawn_spot(mother, 3)) {
        return { id, kind: "zombie", zombie: kind, lvl, cost: MUTATION_COST.zombie(lvl),
                 title: "新丧尸", desc: `在母巢旁孵化 Lv${lvl}【${ZTYPES[kind].name}】` };
      }
      const value = 8 + d;
      return { id: "exp", kind: "exp", value, cost: MUTATION_COST.exp(value),
               title: "母巢经验", desc: `母巢获得 ${value} 点经验` };
    }
    // upgrade：随机 1~2 级；场上没有能升的丧尸时换成经验，保证三项都能用
    const value = this.rng.randint(1, 2);
    const fits = this.units.some((u) =>
      u.side === "z" && !u.mother && u.hp > 0 && u.lvl + value <= MAX_LVL);
    if (fits) {
      return { id, kind: "upgrade", value, cost: MUTATION_COST.upgrade(value),
               title: "丧尸升级", desc: `让一只丧尸提升 ${value} 级（最高 Lv${MAX_LVL}）` };
    }
    const exp = 8 + d;
    return { id: "exp", kind: "exp", value: exp, cost: MUTATION_COST.exp(exp),
             title: "母巢经验", desc: `母巢获得 ${exp} 点经验` };
  }

  _act_mutate(p) {
    const m = this.mutation;
    if (!m) throw new ActError("现在不在突变层");
    const opt = m.options.find((o) => o.id === p.id);
    if (!opt) throw new ActError("没有这项突变");
    if (m.bought[opt.id]) throw new ActError("这项突变已经拿过了");
    if (this.biomass < opt.cost) throw new ActError(`生物质不足（需要 ${opt.cost}）`);
    // 先验证效果再扣钱，花了生物质却拿不到东西最难受
    let tgt = null, spot = null;
    if (opt.kind === "zombie") {
      const mother = this.units.find((u) => u.mother) || null;
      spot = mother ? this._spawn_spot(mother, 3) : null;
      if (!spot) throw new ActError("母巢周围没有空位");
    } else if (opt.kind === "upgrade") {
      tgt = this.by_id(p.uid);
      if (!tgt || tgt.hp <= 0 || tgt.side !== "z" || tgt.mother) throw new ActError("请选择一只丧尸");
      if (tgt.lvl + opt.value > MAX_LVL) throw new ActError(`${ZTYPES[tgt.kind].name} 升不了这么多级`);
    }
    this.biomass -= opt.cost;
    m.bought[opt.id] = true;
    if (opt.kind === "exp") {
      this._gain_exp(opt.value);
      this._say(`突变：母巢吞下 ${opt.value} 点经验。`);
    } else if (opt.kind === "relic") {
      this.relics.push(opt.relic);
      this._rxc = null;
      this._apply_fx(RELICS[opt.relic].fx);
      this._say(`突变：获得【${RARITY[RELICS[opt.relic].r].name}】感染物` +
                `【${RELICS[opt.relic].name}】。`);
      this._check_pairs();
    } else if (opt.kind === "zombie") {
      this._add("z", opt.zombie, spot[0], spot[1], { lvl: opt.lvl });
      this._say(`突变：尸块蠕动着拼成一只 Lv${opt.lvl}【${ZTYPES[opt.zombie].name}】。`);
    } else {
      for (let i = 0; i < opt.value; i++) this._levelup(tgt, true);
      this._say(`突变：${this._uname(tgt)} 连升 ${opt.value} 级，到 Lv${tgt.lvl}。`);
    }
  }

  _act_mutation_done() {
    if (!this.mutation) return;
    const next = this.mutation.next;
    this.mutation = null;
    this._goNextStop(next);
  }

  _goNextStop(next) {
    this.map_i = clamp(int(next.map_i), 0, MAPS_PER_RUN - 1);
    this.layer_i = clamp(int(next.layer_i), 0, LAYERS_PER_MAP - 1);
    this.map_cfg = MAPS[Math.min(this.map_i, MAPS.length - 1)];
    const keep = this.units.filter((u) => u.side === "z" && u.hp > 0);
    this._enter_layer(keep);
    this._refill_team();
    this._say(`── 深入【${this.where()}】${this.map_cfg.sub} ──`);
  }

  _refill_team() {
    const m = this.units.find((u) => u.mother);
    if (!m || !this.unlocked.length) return;
    const target = 3 + Math.floor(this.depth / 2);
    let have = this.units.filter((u) => u.side === "z" && !u.mother).length;
    const lvl = Math.max(clamp(1 + Math.floor(this.depth / 3), 1, MAX_LVL), this.hatch_level());
    // 催腐者没有攻击力，别让自动补员把它当主力刷出来
    const pool = this.unlocked.filter((k) => k !== "rotter");
    let added = 0;
    while (have < target && added < 6) {
      const kind = this.rng.choice(pool.length ? pool : this.unlocked.slice().sort());
      const spot = this._spawn_spot(m, 3);
      if (!spot) break;
      this._add("z", kind, spot[0], spot[1], { lvl: lvl });
      have += 1;
      added += 1;
    }
    if (added) this._say(`层间补员：母体产下 ${added} 只 Lv${lvl} 丧尸（现役 ${have} 只）。`);
  }

  _spawn_wave() {
    const m = this.units.find((u) => u.mother);
    if (!m) return;
    const spots = this._bfs(this.grid, [m.x, m.y]).list.filter(
      ([x, y]) => distp(x, y, m.x, m.y) >= 7 && this._free(x, y));
    this.rng.shuffle(spots);
    let n = 0;
    const want = this.cfg.spawn_n + Math.floor(this.depth / 4);
    for (let i = 0; i < want; i++) {
      if (!spots.length) break;
      const [x, y] = spots.pop();
      this._add("h", this._pick_human_kind(), x, y);
      n += 1;
    }
    if (n) this._say(`远处传来动静：${n} 名人类进入区域。`);
  }

  _tick_cocoons() {
    for (const c of this.cocoons.slice()) {
      c.life -= 1;
      if (c.life <= 0) {
        const i = this.cocoons.indexOf(c);
        if (i >= 0) this.cocoons.splice(i, 1);
        if (this.pending && this.pending.x === c.x && this.pending.y === c.y) this.pending = null;
        this._say("一枚尸茧烂在了原地。");
      }
    }
  }

  _enemy_phase() {
    for (const e of this.units.slice()) {
      if (e.side !== "h" || e.hp <= 0 || this.over) continue;
      const px = e.x, py = e.y;
      this._enemy_turn(e);
      if ((e.x !== px || e.y !== py) && e.hp > 0) {
        const lk = this._look(e);
        this._ev({ t: "move", uid: e.uid, fx: px, fy: py, tx: e.x, ty: e.y,
                   side: "h", mother: false, short: lk.short, color: lk.color });
      }
    }
  }

  _losTo(a, b) {
    if (b.size !== MOTHER_SIZE) return this.los(a.x, a.y, b.x, b.y);
    for (const c of this.cells(b)) if (this.los(a.x, a.y, c[0], c[1])) return true;
    return false;
  }

  _in_reach(e, t) {
    if (t.size === MOTHER_SIZE) return this.unitDist(e, t) <= Math.max(1, e.rng) + 0.01;
    if (HTYPES[e.kind].melee8) return cheb(e, t) <= 1;
    return dist(e, t) <= e.rng + 0.01;
  }

  /** 肉垒的嘲讽：贴着母巢时，把远程人类的火力从母巢引到自己身上 */
  _taunt_target(e) {
    const kind = HTYPES[e.kind];
    if (!kind || !(kind.aim || e.rng >= 4)) return null;
    const mother = this.units.find((u) => u.mother && u.hp > 0);
    if (!mother) return null;
    const bs = this.units.filter((u) =>
      u.side === "z" && u.hp > 0 && u.kind === "bulwark" &&
      this.unitDist(u, mother) <= 3.01 &&
      this.unitDist(e, u) <= e.rng + 0.01 && this._losTo(e, u));
    if (!bs.length) return null;
    bs.sort((a, b) => this.unitDist(e, a) - this.unitDist(e, b));
    return bs[0];
  }

  _targets_in_reach(e) {
    const out = this.units.filter((u) =>
      u.side === "z" && u.hp > 0 && this._in_reach(e, u) && this._losTo(e, u));
    const taunt = this._taunt_target(e);
    out.sort((a, b) => {
      const at = taunt && a === taunt ? 0 : 1;
      const bt = taunt && b === taunt ? 0 : 1;
      if (at !== bt) return at - bt;
      const am = (a.mother && this.unitDist(e, a) <= 2.0) ? 0 : 1;
      const bm = (b.mother && this.unitDist(e, b) <= 2.0) ? 0 : 1;
      if (am !== bm) return am - bm;
      if (a.hp !== b.hp) return a.hp - b.hp;
      return this.unitDist(e, a) - this.unitDist(e, b);
    });
    return out;
  }

  /**
   * 狙击手的锁定/开枪节奏。
   * 没有锁 → 挑一个射程内目标锁定（aim=1），本回合不开枪；
   * 已锁定且目标仍在射程+视线内 → aim+1，攒满 kind.aim 回合再开枪；
   * 目标死掉/跑出射程/断视线 → 解锁，交给调用者重新找目标或移动。
   * @returns "aiming" | "fired" | "none"
   */
  _sniperAim(e, kind) {
    const taunt = this._taunt_target(e);
    if (taunt && e.aim_uid !== taunt.uid) {
      e.aim = 1;
      e.aim_uid = taunt.uid;
      this._say(`${kind.name} 被肉垒吸引，改锁定 ${this._uname(taunt)}，下一回合开枪。`);
      return "aiming";
    }
    const locked = e.aim_uid ? this.by_id(e.aim_uid) : null;
    const valid = !!locked && locked.hp > 0 && locked.side === "z" &&
      this.unitDist(e, locked) <= e.rng + 0.01 && this._losTo(e, locked);
    if (!valid) {
      e.aim = 0;
      e.aim_uid = 0;
    }
    if (e.aim_uid) {
      e.aim += 1;
      if (e.aim < kind.aim) return "aiming";
      const dmg = this._damage(locked, e.atk, kind.name, e);
      this._say(`${kind.name} 锁定 ${this._uname(locked)} 扣下扳机，${dmg} 伤害。`);
      e.aim = 0;
      e.aim_uid = 0;
      return "fired";
    }
    const cands = this._targets_in_reach(e);
    if (cands.length) {
      const t = cands[0];
      e.aim = 1;
      e.aim_uid = t.uid;
      this._say(`${kind.name} 锁定 ${this._uname(t)}，下一回合开枪。`);
      return "aiming";
    }
    return "none";
  }

  _enemy_turn(e) {
    const kind = HTYPES[e.kind];
    const mother = this.units.find((u) => u.mother) || null;
    const can_move = e.bound <= 0;
    if (!can_move) {
      e.bound -= 1;
      this._say(`${kind.name} 被菌丝缠住，动弹不得。`);
    }
    const targets = this.units.filter((u) =>
      u.side === "z" && u.hp > 0 && this.unitDist(e, u) <= e.sight && this._losTo(e, u));
    targets.sort((a, b) => {
      const am = (a.mother && this.unitDist(e, a) <= 3.0) ? 0 : 1;
      const bm = (b.mother && this.unitDist(e, b) <= 3.0) ? 0 : 1;
      if (am !== bm) return am - bm;
      return this.unitDist(e, a) - this.unitDist(e, b);
    });

    if (kind.heal) {
      const hurt = this.units.filter((o) =>
        o.side === "h" && o.hp > 0 && o !== e && o.hp < o.max_hp &&
        Math.abs(o.x - e.x) <= 1 && Math.abs(o.y - e.y) <= 1);
      if (hurt.length) {
        hurt.sort((a, b) => (a.hp / a.max_hp) - (b.hp / b.max_hp));
        const t = hurt[0];
        t.hp = Math.min(t.max_hp, t.hp + kind.heal);
        this._say(`医生为 ${HTYPES[t.kind].name} 包扎（+${kind.heal}）。`);
        return;
      }
    }

    const atks = kind.atks === undefined ? 1 : int(kind.atks);
    let shots = 0;
    if (kind.aim) {
      // 狙击手：先锁定一个目标，下一回合才开枪；目标跑掉/死掉就重新找
      const aim = this._sniperAim(e, kind);
      if (aim !== "none") return;
    } else {
      for (let i = 0; i < atks; i++) {
        const hit = this._targets_in_reach(e);
        if (!hit.length) break;
        const t = hit[0];
        const dmg = this._damage(t, e.atk, kind.name, e);
        this._say(`${kind.name} 攻击 ${this._uname(t)}，${dmg} 伤害。`);
        shots += 1;
      }
      if (shots) return;
    }

    if (targets.length && can_move) {
      if (kind.flee) this._step_away(e, targets[0]);
      else this._step_toward(e, targets[0]);
    } else if (!targets.length && can_move) {
      const hunt = kind.hunt || 0;
      if (mother && this.rng.random() < hunt) {
        this._step_toward(e, mother);
      } else {
        for (let s = 0; s < ENEMY_STEP; s++) {
          const dirs = DIRS4.slice();
          this.rng.shuffle(dirs);
          for (const [dx, dy] of dirs) {
            if (this._free(e.x + dx, e.y + dy) && this.rng.random() < 0.8) {
              e.x += dx; e.y += dy;
              break;
            }
          }
        }
      }
    }

    if (!kind.aim) {
      for (let i = 0; i < atks; i++) {
        const hit = this._targets_in_reach(e);
        if (!hit.length) break;
        const dmg = this._damage(hit[0], e.atk, kind.name, e);
        this._say(`${kind.name} 开火，${this._uname(hit[0])} 受到 ${dmg} 伤害。`);
      }
    }
  }

  _step_toward(e, t) {
    for (let s = 0; s < ENEMY_STEP; s++) {
      let best = null, bd = dist(e, t);
      for (const [dx, dy] of DIRS4) {
        const nx = e.x + dx, ny = e.y + dy;
        if (!this._free(nx, ny)) continue;
        const d = distp(nx, ny, t.x, t.y);
        if (d < bd) { best = [nx, ny]; bd = d; }
      }
      if (!best) return;
      e.x = best[0]; e.y = best[1];
    }
  }

  _step_away(e, t) {
    for (let s = 0; s < ENEMY_STEP; s++) {
      let best = null, bd = dist(e, t);
      for (const [dx, dy] of DIRS4) {
        const nx = e.x + dx, ny = e.y + dy;
        if (!this._free(nx, ny)) continue;
        const d = distp(nx, ny, t.x, t.y);
        if (d > bd) { best = [nx, ny]; bd = d; }
      }
      if (!best) return;
      e.x = best[0]; e.y = best[1];
    }
  }

  // ── 输出 ─────────────────────────────────────────────
  _uname(u) {
    if (u.mother) return `母体·${MOTHERS[this.mother_kind].name}`;
    const n = u.side === "z" ? ZTYPES[u.kind].name : HTYPES[u.kind].name;
    return `${n}#${u.uid}`;
  }

  _hname(u) { return u.side === "h" ? HTYPES[u.kind].name : this._uname(u); }

  _say(s) {
    this.log.push(s);
    if (this.log.length > 120) this.log = this.log.slice(-120);
  }

  snapshot() {
    const m = this.units.find((u) => u.mother) || null;
    const outUnits = [];
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      if (u.side === "h" && !this.visible.has(key(u.x, u.y))) continue;
      const base = u.mother ? MOTHERS[this.mother_kind]
        : (u.side === "z" ? ZTYPES[u.kind] : HTYPES[u.kind]);
      const item = {
        uid: u.uid, side: u.side, kind: u.kind,
        name: u.mother ? ("母体·" + base.name) : base.name,
        short: base.short || "母",
        x: u.x, y: u.y, hp: u.hp, max_hp: u.max_hp,
        atk: u.atk, rng: u.rng, sight: u.sight, shield: u.shield,
        acted: u.acted, mother: u.mother, aim: u.aim, aim_uid: u.aim_uid || 0,
        lvl: u.lvl, size: u.size || 1,
        color: base.color, shape: base.shape,
      };
      if (u.side === "z" && !u.mother) {
        const r = this.reachable(u, this.ap);
        const reach = [];
        for (const [k, c] of r.dist) {
          if (c > 0) { const p = k.split(","); reach.push([+p[0], +p[1], c]); }
        }
        item.reach = reach;
        // 催腐者没有攻击力：不给自己也不给 UI 任何"可攻击目标"
        item.targets = u.atk <= 0 ? [] : this.units
          .filter((t) => t.side === "h" && t.hp > 0 &&
                         dist(u, t) <= u.rng + 0.01 && this.los(u.x, u.y, t.x, t.y))
          .map((t) => t.uid);
      }
      outUnits.push(item);
    }

    const threat = [];
    const thSeen = new Set();
    for (const e of this.units) {
      if (e.side !== "h" || e.hp <= 0) continue;
      if (!this.visible.has(key(e.x, e.y))) continue;
      for (const [x, y] of this.disc(e.x, e.y, e.rng)) {
        if (this.los(e.x, e.y, x, y) && !thSeen.has(key(x, y))) {
          thSeen.add(key(x, y));
          threat.push([x, y]);
        }
      }
    }

    const seenGrid = [], visGrid = [];
    for (let y = 0; y < H; y++) {
      const rs = [], rv = [];
      for (let x = 0; x < W; x++) {
        rs.push(this.seen.has(key(x, y)) ? 1 : 0);
        rv.push(this.visible.has(key(x, y)) ? 1 : 0);
      }
      seenGrid.push(rs); visGrid.push(rv);
    }

    const ztypes = {};
    for (const k of Object.keys(ZTYPES)) {
      const v = ZTYPES[k];
      ztypes[k] = {
        name: v.name, short: v.short, hp: v.hp, atk: v.atk, rng: v.rng, sight: v.sight,
        color: v.color, shape: v.shape, skill: v.skill, blurb: v.blurb,
        unlock_lvl: v.unlock_lvl || 0,
        levels: [1, 2, 3].map((lv) => zstats(k, lv)),
      };
    }
    const diffs = {};
    for (const k of Object.keys(DIFFS)) {
      diffs[k] = { label: DIFFS[k].label, turns: DIFFS[k].turns, ap: DIFFS[k].ap,
                   start_z: DIFFS[k].start_z, start_h: DIFFS[k].start_h };
    }
    const mothers = {};
    for (const k of Object.keys(MOTHERS)) {
      const v = MOTHERS[k];
      mothers[k] = { name: v.name, hp: v.hp, skill: v.skill, desc: v.desc, cd: v.cd };
    }
    const relicsMeta = {};
    for (const k of Object.keys(RELICS)) {
      const v = RELICS[k];
      relicsMeta[k] = { name: v.name, tag: v.tag, color: v.color, desc: v.desc,
                        r: v.r, rarity: RARITY[v.r].name, rarity_color: RARITY[v.r].color,
                        fx: Object.assign({}, v.fx) };
    }
    const terrainMeta = TERR.map((t) => ({
      name: t.name, color: t.color, pat: t.pat, cost: t.cost,
      cover: t.cover || 0, blockLos: !!t.blockLos, block: !!t.block,
      healZ: t.healZ || 0, desc: t.desc,
    }));
    const pairsMeta = PAIRS.map((p) => ({ id: p.id, name: p.name, need: p.need.slice(), desc: p.desc }));

    const out = {
      w: W, h: H,
      grid: this.grid,
      turn: this.turn,
      turns_total: this.cfg.turns,
      map: this.tut_i == null ? {
        i: this.map_i, total: MAPS_PER_RUN,
        name: this.map_name(), sub: this.map_cfg.sub || "",
        layer: this.layer_i, layers: LAYERS_PER_MAP,
        depth: this.depth, run_layers: RUN_LAYERS,
        layers_done: this.layers_done,
      } : {
        i: this.tut_i, total: TUT_LEVELS.length,
        name: TUT_LEVELS[this.tut_i].name, sub: "新手教程",
        layer: 0, layers: 1,
        depth: 0, run_layers: TUT_LEVELS.length,
        layers_done: this.tut_i,
      },
      tut: this.tut_i == null ? null : {
        i: this.tut_i, n: TUT_LEVELS.length,
        name: TUT_LEVELS[this.tut_i].name,
        goal: TUT_LEVELS[this.tut_i].goal,
        goal_text: TUT_LEVELS[this.tut_i].goalText,
        hint: TUT_LEVELS[this.tut_i].hint,
        done: this.tut_done,
        last: this.tut_i >= TUT_LEVELS.length - 1,
      },
      stage_clear: this.stage_clear,
      abandoned: this.abandoned,
      ap: this.ap, ap_max: this.ap_max, ap_name: AP_NAME,
      act_limit: this._act_limit(),
      difficulty: this.diff, difficulty_label: this.cfg.label,
      seed: this.seed || 0,
      over: this.over, result: this.result,
      infected: this.infected,
      biomass: this.biomass,
      gained: this.gained,
      unlocked: this.unlocked.slice().sort(),
      relics: this.relics.slice(),
      pairs_active: activePairs(this.relics),
      relic_drops: this.relic_drops.map((r) => Object.assign({}, r)),
      units: outUnits,
      cocoons: this.cocoons.map((c) => Object.assign({}, c)),
      pending: this.pending ? Object.assign({}, this.pending) : null,
      mutation: this.mutation ? {
        options: this.mutation.options.map((o) =>
          Object.assign({}, o, { bought: !!this.mutation.bought[o.id] })),
        biomass: this.biomass,
        from: this.mutation.from,
        depth: this.mutation.depth,
        next: {
          map_i: this.mutation.next.map_i,
          layer_i: this.mutation.next.layer_i,
          name: (MAPS[this.mutation.next.map_i] || MAPS[0]).name,
          layer: this.mutation.next.layer_i + 1,
          layers: LAYERS_PER_MAP,
        },
      } : null,
      seen: seenGrid,
      visible: visGrid,
      threat: threat,
      log: this.log.slice(-14),
      events: this.events,
      mother: {
        kind: this.mother_kind,
        name: MOTHERS[this.mother_kind].name,
        hp: m ? m.hp : 0, max_hp: m ? m.max_hp : 0,
        shield: m ? m.shield : 0,
        skill: MOTHERS[this.mother_kind].skill,
        cd: this.mother_cd,
        desc: MOTHERS[this.mother_kind].desc,
        lvl: this.mother_lvl,
        exp: this.mother_exp,
        exp_need: expNeed(this.mother_lvl),
        hatch_lvl: this.hatch_level(),
        size: MOTHER_SIZE,
      },
      meta: {
        ztypes: ztypes,
        max_lvl: MAX_LVL,
        maps: MAPS.map((x) => ({ name: x.name, sub: x.sub })),
        run_layers: RUN_LAYERS,
        diffs: diffs,
        mothers: mothers,
        relics: relicsMeta,
        rarity: RARITY.map((r) => ({ name: r.name, color: r.color, min: r.min })),
        pairs: pairsMeta,
        terrain: terrainMeta,
        relic_drop_chance: RELIC_DROP_CHANCE,
        exp_kill: Object.assign({}, EXP_KILL),
        exp_layer: EXP_LAYER,
        exp_rotter: EXP_ROTTER,
        hatch_lvl_every: HATCH_LVL_EVERY,
        start_unlocked: START_UNLOCKED.slice(),
      },
    };
    this.events = [];     // 事件已被本次快照带走，清空避免重复播放
    return out;
  }
}

// ─────────────────────────── 会话层 ───────────────────────────
// 原来这层是 run.py 的 HTTP 路由；现在直接在浏览器里调用，一个 Game 实例当引擎。

let G = new Game();
G.new_game({ persist: false });   // 占位对局：不写存档，避免一打开就把"继续游戏"覆盖掉

function state() { return G.snapshot(); }

function newGame(opts) {
  opts = opts || {};
  const raw = opts.seed;
  let seed = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "" && /^\d+$/.test(String(raw).trim())) {
    seed = parseInt(String(raw).trim(), 10);
  }
  if (opts.tut !== undefined && opts.tut !== null) {
    return G.new_game({ seed: seed, tut: opts.tut, persist: false });
  }
  return G.new_game({ seed: seed, mother: opts.mother || "brood",
                      diff: opts.diff || "normal" });
}

function act(payload) { return G.act(payload); }

function profile() { return profilePublic(); }

function resume() {
  const save = loadSave();
  const run = save.run;
  if (!run || typeof run !== "object") return { ok: false, msg: "没有可继续的存档" };
  if (!G.restore_run(run)) {
    G.new_game({ persist: false });
    return { ok: false, msg: "存档已损坏，已为你重置" };
  }
  return { ok: true, msg: "", state: G.snapshot() };
}

function save() {
  G.autosave();
  return { ok: true, profile: profilePublic() };
}

function resetSave() {          // 给调试用：清空本浏览器的档案
  writeSave(defaultSave());
  G.new_game({ persist: false });
}

return {
  VERSION: VERSION, BUILD: BUILD,
  Game: Game, RNG: RNG,
  TUT_LEVELS: TUT_LEVELS,
  state: state, newGame: newGame, act: act, profile: profile,
  resume: resume, save: save, resetSave: resetSave,
  loadSave: loadSave, writeSave: writeSave,
  ZTYPES: ZTYPES, HTYPES: HTYPES, MOTHERS: MOTHERS, DIFFS: DIFFS, MAPS: MAPS,
  TERR: TERR, RELICS: RELICS, RARITY: RARITY, PAIRS: PAIRS,
  W: W, H: H, RUN_LAYERS: RUN_LAYERS, MAPS_PER_RUN: MAPS_PER_RUN,
  LAYERS_PER_MAP: LAYERS_PER_MAP,
  scentCells: scentCells,
};
});
