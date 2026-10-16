'use strict';
/* ============================================================
 * 多机器人智能仓库仿真 · main.js
 * v0.1.0 — 静态仓库场景：地板 / 网格 / 货架 / 主站 / 卸货区
 *
 * 架构：
 *   - 逻辑与渲染分离，requestAnimationFrame 单循环驱动
 *   - 静态层（地板、网格、货架、主站、卸货区）预渲染到离屏 Canvas，
 *     每帧仅一次 drawImage；动态元素（环境光效，后续版本的机器人 /
 *     货物 / 路径 / 粒子）叠加在其上
 *   - 高 DPI：backing store = CSS 尺寸 × devicePixelRatio，
 *     resize / DPR 变化时自动重建静态层
 *
 * 后续版本扩展点：
 *   v0.2 PathPlanner / Robot / Simulation
 *   v0.5 UI（DOM 面板绑定）
 * ============================================================ */

/* ---------------- 全局配置 ---------------- */
const CFG = {
  COLS: 28,
  ROWS: 18,

  // 主站（左下）与卸货区（右上），单位：格，含端点
  HOME: { x0: 1, y0: 13, x1: 4, y1: 16 },
  DROP: { x0: 23, y0: 1, x1: 26, y1: 4 },

  // 货架排：横向长条、2 格厚，每 2 格为一个货位（共 3 排 × 6 货位）
  // 布局对称：主站 x1-4 | 通道 x5-7 | 货架 x8-19 | 通道 x20-22 | 卸货区 x23-26
  SHELVES: [
    { row: 'A', x0: 8, y0: 3, x1: 19, y1: 4 },
    { row: 'B', x0: 8, y0: 8, x1: 19, y1: 9 },
    { row: 'C', x0: 8, y0: 13, x1: 19, y1: 14 },
  ],

  PAL: {
    pageBg: '#0B1220',
    outside: '#0A0F1C',                    // 画布网格区域之外的暗色
    floor: '#111C2E',
    gridLine: 'rgba(148,163,184,0.08)',
    shelfTop: '#26364D',
    shelfSide: '#1E293B',
    shelfHi: '#475569',
    shelfBeam: 'rgba(51,65,85,0.9)',
    home: '#3B82F6',
    homeGlow: 'rgba(59,130,246,0.35)',
    drop: '#22C55E',
    dropGlow: 'rgba(34,197,94,0.35)',
    text: '#E2E8F0',
    textDim: '#94A3B8',
  },

  ROBOT_COLORS: ['#38BDF8', '#F472B6', '#FACC15', '#4ADE80',
                 '#A78BFA', '#FB923C', '#F87171', '#2DD4BF'],
  MAX_ROBOTS: 8,
};

/* ---------------- 通用工具 ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** 确定性随机（mulberry32）：静态纹理用固定种子，重建结果一致 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 圆角矩形路径（不依赖较新的 ctx.roundRect） */
function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** 充电桩闪电符号（cx/cy 中心，s 半高） */
function boltPath(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx + 0.22 * s, cy - s);
  ctx.lineTo(cx - 0.38 * s, cy + 0.10 * s);
  ctx.lineTo(cx - 0.02 * s, cy + 0.10 * s);
  ctx.lineTo(cx - 0.22 * s, cy + s);
  ctx.lineTo(cx + 0.38 * s, cy - 0.10 * s);
  ctx.lineTo(cx + 0.02 * s, cy - 0.10 * s);
  ctx.closePath();
}

/** 指向右的箭头 chevron（cx/cy 中心，w/h 宽高） */
function chevronPath(ctx, cx, cy, w, h) {
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy);
  ctx.lineTo(cx - w / 2, cy + h / 2);
}

/* ---------------- 网格与地图数据 ---------------- */
const CELL = { FLOOR: 0, SHELF: 1, HOME: 2, DROP: 3, OBST: 4 };

class Grid {
  constructor() { this.rebuild(); }

  /** 根据布局配置重建格子类型 */
  rebuild() {
    this.cells = Array.from({ length: CFG.ROWS }, () => new Array(CFG.COLS).fill(CELL.FLOOR));
    const mark = (zone, type) => {
      for (let y = zone.y0; y <= zone.y1; y++)
        for (let x = zone.x0; x <= zone.x1; x++)
          this.cells[y][x] = type;
    };
    for (const s of CFG.SHELVES) mark(s, CELL.SHELF);
    mark(CFG.HOME, CELL.HOME);
    mark(CFG.DROP, CELL.DROP);
  }

  inBounds(x, y) { return x >= 0 && x < CFG.COLS && y >= 0 && y < CFG.ROWS; }
  at(x, y) { return this.inBounds(x, y) ? this.cells[y][x] : CELL.SHELF; }

  /** 货架与障碍不可通行；主站 / 卸货区 / 普通地板可通行 */
  walkable(x, y) {
    const c = this.at(x, y);
    return c === CELL.FLOOR || c === CELL.HOME || c === CELL.DROP;
  }
}

/* ---------------- 渲染器 ---------------- */
class Renderer {
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.grid = grid;
    this.dpr = 0;          // resize() 内会真正赋值
    this.cs = 32;          // 单格 CSS 像素尺寸
    this.ox = 0; this.oy = 0;   // 网格区域在画布内的原点（居中 letterbox）
    this.gw = 0; this.gh = 0;   // 网格区域像素尺寸
    this.staticLayer = document.createElement('canvas');
  }

  /** 容器 / DPR 变化时重算尺寸并重建静态层 */
  resize() {
    const parent = this.canvas.parentElement;
    const cssW = Math.max(1, Math.floor(parent.clientWidth));
    const cssH = Math.max(1, Math.floor(parent.clientHeight));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);

    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    // 网格铺满可用区域（四周留 12px 呼吸空间），格子尺寸限幅
    this.cs = clamp(Math.floor(Math.min((cssW - 24) / CFG.COLS, (cssH - 24) / CFG.ROWS)), 14, 48);
    this.gw = this.cs * CFG.COLS;
    this.gh = this.cs * CFG.ROWS;
    this.ox = Math.round((cssW - this.gw) / 2);
    this.oy = Math.round((cssH - this.gh) / 2);

    this.buildStaticLayer();
  }

  /* ----- 坐标换算 ----- */
  px(x) { return this.ox + x * this.cs; }
  py(y) { return this.oy + y * this.cs; }

  /* ============================================================
   * 静态层：一次性绘制，resize 时重建
   * ============================================================ */
  buildStaticLayer() {
    const s = this.staticLayer;
    s.width = this.canvas.width;
    s.height = this.canvas.height;
    const c = s.getContext('2d');
    c.scale(this.dpr, this.dpr);

    // 网格区域之外的暗色底
    c.fillStyle = CFG.PAL.outside;
    c.fillRect(0, 0, this.cssW, this.cssH);

    // 地板（带投影，形成"悬浮桌面"感）
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.55)';
    c.shadowBlur = 28;
    c.shadowOffsetY = 8;
    rr(c, this.ox, this.oy, this.gw, this.gh, 12);
    c.fillStyle = CFG.PAL.floor;
    c.fill();
    c.restore();

    // 地板内部细节全部裁剪在圆角内
    c.save();
    rr(c, this.ox, this.oy, this.gw, this.gh, 12);
    c.clip();

    this.drawFloorTexture(c);
    this.drawAmbientTints(c);
    this.drawVignette(c);
    this.drawGridLines(c);
    this.drawShelfRowLetters(c);
    this.drawDropChevrons(c);
    for (const shelf of CFG.SHELVES) this.drawShelfRow(c, shelf);
    this.drawHomeZone(c);
    this.drawDropZone(c);

    c.restore();

    // 外边框
    rr(c, this.ox + 0.5, this.oy + 0.5, this.gw - 1, this.gh - 1, 12);
    c.strokeStyle = 'rgba(148,163,184,0.16)';
    c.lineWidth = 1;
    c.stroke();
  }

  /** 环氧地坪噪点：按设备分辨率生成，明暗双向、极低透明度 */
  drawFloorTexture(c) {
    const w = this.gw * this.dpr, h = this.gh * this.dpr;
    const nc = document.createElement('canvas');
    nc.width = w; nc.height = h;
    const nctx = nc.getContext('2d');
    const img = nctx.createImageData(w, h);
    const rnd = mulberry32(20261015);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 2;         // -1 ~ 1
      const v = n > 0 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = Math.floor(Math.abs(n) * 12);   // alpha ≤ 12，克制
    }
    nctx.putImageData(img, 0, 0);
    c.drawImage(nc, this.ox, this.oy, this.gw, this.gh);
  }

  /** 主站 / 卸货区方向的环境色渐染 */
  drawAmbientTints(c) {
    const zone = (cx, cy, r, color) => {
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(this.ox, this.oy, this.gw, this.gh);
    };
    const mid = (z) => ({ x: this.px((z.x0 + z.x1 + 1) / 2), y: this.py((z.y0 + z.y1 + 1) / 2) });
    const h = mid(CFG.HOME), d = mid(CFG.DROP);
    zone(h.x, h.y, this.cs * 7, 'rgba(59,130,246,0.055)');
    zone(d.x, d.y, this.cs * 7, 'rgba(34,197,94,0.055)');
  }

  /** 四角压暗，突出中心 */
  drawVignette(c) {
    const cx = this.ox + this.gw / 2, cy = this.oy + this.gh / 2;
    const g = c.createRadialGradient(cx, cy, Math.min(this.gw, this.gh) * 0.35, cx, cy, Math.max(this.gw, this.gh) * 0.72);
    g.addColorStop(0, 'rgba(2,6,17,0)');
    g.addColorStop(1, 'rgba(2,6,17,0.42)');
    c.fillStyle = g;
    c.fillRect(this.ox, this.oy, this.gw, this.gh);
  }

  /** 淡网格线 */
  drawGridLines(c) {
    c.strokeStyle = CFG.PAL.gridLine;
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i <= CFG.COLS; i++) {
      const x = Math.round(this.px(i)) + 0.5;
      c.moveTo(x, this.oy); c.lineTo(x, this.oy + this.gh);
    }
    for (let j = 0; j <= CFG.ROWS; j++) {
      const y = Math.round(this.py(j)) + 0.5;
      c.moveTo(this.ox, y); c.lineTo(this.ox + this.gw, y);
    }
    c.stroke();
  }

  /** 通道地面喷漆排号 A / B / C（货架两侧通道中央） */
  drawShelfRowLetters(c) {
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(148,163,184,0.40)';
    c.font = `800 ${Math.round(this.cs * 1.05)}px system-ui, sans-serif`;
    for (const s of CFG.SHELVES) {
      const cy = this.py((s.y0 + s.y1 + 1) / 2);
      c.fillText(s.row, this.px(6.5), cy);
      c.fillText(s.row, this.px(21.5), cy);
    }
  }

  /** 通道内指向卸货区的地面箭头（x=20~22 通道，y=3 行中央，正对装卸口） */
  drawDropChevrons(c) {
    const cy = this.py(3.0);
    c.strokeStyle = 'rgba(74,222,128,0.5)';
    c.lineWidth = 2.4;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (let k = 0; k < 3; k++) {
      const cx = this.px(20.6 + k * 0.6);
      chevronPath(c, cx, cy, this.cs * 0.36, this.cs * 0.44);
      c.stroke();
    }
  }

  /** 货架排：投影 → 侧面 → 顶面 → 高光 → 货位结构 → 编号 */
  drawShelfRow(c, s) {
    const cs = this.cs;
    const x = this.px(s.x0), y = this.py(s.y0);
    const w = (s.x1 - s.x0 + 1) * cs;
    const h = (s.y1 - s.y0 + 1) * cs;
    const depth = Math.max(3, Math.round(cs * 0.14));   // 侧面（前立面）厚度
    const rad = Math.max(5, Math.round(cs * 0.18));

    // 投影
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 14;
    c.shadowOffsetY = 5;
    rr(c, x + 1, y + 1, w - 2, h - 2, rad);
    c.fillStyle = CFG.PAL.shelfSide;
    c.fill();
    c.restore();

    // 顶面（略短，露出下缘侧面形成厚度感）
    const topH = h - depth;
    const g = c.createLinearGradient(0, y, 0, y + topH);
    g.addColorStop(0, '#2E4059');
    g.addColorStop(1, CFG.PAL.shelfTop);
    rr(c, x, y, w, topH, rad);
    c.fillStyle = g;
    c.fill();

    // 顶面外框高光
    c.strokeStyle = CFG.PAL.shelfHi;
    c.lineWidth = 1;
    rr(c, x + 0.5, y + 0.5, w - 1, topH - 1, rad);
    c.stroke();

    // 货位结构：每 2 格一个货位
    const bays = (s.x1 - s.x0 + 1) / 2;
    for (let i = 0; i < bays; i++) {
      const bx = x + i * 2 * cs;
      const bw = 2 * cs;

      // 货位内横梁（两条）
      c.strokeStyle = CFG.PAL.shelfBeam;
      c.lineWidth = 1.5;
      c.beginPath();
      for (const f of [0.34, 0.68]) {
        const ly = y + topH * f;
        c.moveTo(bx + 5, ly); c.lineTo(bx + bw - 5, ly);
      }
      c.stroke();

      // 货位编号（如 A3）
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      c.fillStyle = 'rgba(148,163,184,0.62)';
      c.font = `600 ${Math.max(9, Math.round(cs * 0.27))}px system-ui, sans-serif`;
      c.fillText(`${s.row}${i + 1}`, bx + 5, y + Math.max(11, topH * 0.27));
    }

    // 货位分隔梁 + 立柱
    for (let i = 1; i < bays; i++) {
      const sx = x + i * 2 * cs;
      c.strokeStyle = CFG.PAL.shelfSide;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(sx, y + 3); c.lineTo(sx, y + topH - 3);
      c.stroke();
      c.fillStyle = CFG.PAL.shelfHi;
      for (const py2 of [y + 4, y + topH - 4]) {
        c.beginPath();
        c.arc(sx, py2, 1.6, 0, Math.PI * 2);
        c.fill();
      }
    }
    // 四角立柱
    c.fillStyle = CFG.PAL.shelfHi;
    for (const [cx2, cy2] of [[x + 4, y + 4], [x + w - 4, y + 4], [x + 4, y + topH - 4], [x + w - 4, y + topH - 4]]) {
      c.beginPath();
      c.arc(cx2, cy2, 2, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** 主站：发光平台 + 充电桩 + 停车位虚线 + 标牌 */
  drawHomeZone(c) {
    const z = CFG.HOME, cs = this.cs, P = CFG.PAL;
    const pad = 3;
    const x = this.px(z.x0) + pad, y = this.py(z.y0) + pad;
    const w = (z.x1 - z.x0 + 1) * cs - pad * 2;
    const h = (z.y1 - z.y0 + 1) * cs - pad * 2;
    const rad = Math.max(8, Math.round(cs * 0.3));

    // 平台底色 + 发光边框
    c.save();
    c.shadowColor = P.homeGlow;
    c.shadowBlur = 22;
    rr(c, x, y, w, h, rad);
    c.fillStyle = 'rgba(59,130,246,0.08)';
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(59,130,246,0.55)';
    c.lineWidth = 1.5;
    rr(c, x, y, w, h, rad);
    c.stroke();
    c.restore();

    // 充电桩（平台左上格）
    const dx = this.px(z.x0) + cs * 0.18, dy = this.py(z.y0) + cs * 0.15;
    const dw = cs * 0.64, dh = cs * 0.70;
    rr(c, dx, dy, dw, dh, 5);
    c.fillStyle = '#1E293B';
    c.fill();
    c.strokeStyle = 'rgba(59,130,246,0.65)';
    c.lineWidth = 1.2;
    c.stroke();
    c.save();
    c.shadowColor = 'rgba(96,165,250,0.9)';
    c.shadowBlur = 7;
    boltPath(c, dx + dw / 2, dy + dh / 2, cs * 0.17);
    c.fillStyle = '#7DB8FF';
    c.fill();
    c.restore();

    // 停车位（虚线圆角格 × 3）
    c.setLineDash([5, 4]);
    c.strokeStyle = 'rgba(59,130,246,0.42)';
    c.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      const sx = this.px(z.x0 + 1 + i) + 5, sy = this.py(z.y0) + 5;
      rr(c, sx, sy, cs - 10, cs - 10, 6);
      c.stroke();
    }
    c.setLineDash([]);

    // 标牌（平台下半部居中，两行）
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(96,165,250,0.9)';
    c.font = `700 ${Math.round(cs * 0.5)}px system-ui, sans-serif`;
    c.fillText('HOME', x + w / 2, y + h * 0.62);
    c.fillStyle = 'rgba(148,163,184,0.8)';
    c.font = `${Math.round(cs * 0.32)}px system-ui, sans-serif`;
    c.fillText('主站', x + w / 2, y + h * 0.85);
  }

  /** 卸货区：发光平台 + 装卸口 + 标牌 */
  drawDropZone(c) {
    const z = CFG.DROP, cs = this.cs, P = CFG.PAL;
    const pad = 3;
    const x = this.px(z.x0) + pad, y = this.py(z.y0) + pad;
    const w = (z.x1 - z.x0 + 1) * cs - pad * 2;
    const h = (z.y1 - z.y0 + 1) * cs - pad * 2;
    const rad = Math.max(8, Math.round(cs * 0.3));

    // 平台底色 + 发光边框
    c.save();
    c.shadowColor = P.dropGlow;
    c.shadowBlur = 22;
    rr(c, x, y, w, h, rad);
    c.fillStyle = 'rgba(34,197,94,0.08)';
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(34,197,94,0.55)';
    c.lineWidth = 1.5;
    rr(c, x, y, w, h, rad);
    c.stroke();
    c.restore();

    // 装卸口（左边缘朝向仓库，两扇发光门）
    for (const ry of [z.y0 + 1, z.y0 + 2]) {
      const dx = this.px(z.x0) + cs * 0.08;
      const dy = this.py(ry) + cs * 0.17;
      const dw = cs * 0.3, dh = cs * 0.66;
      c.save();
      c.shadowColor = 'rgba(34,197,94,0.7)';
      c.shadowBlur = 8;
      rr(c, dx, dy, dw, dh, 3);
      c.fillStyle = 'rgba(34,197,94,0.22)';
      c.fill();
      c.strokeStyle = 'rgba(74,222,128,0.8)';
      c.lineWidth = 1.2;
      c.stroke();
      c.restore();
    }

    // 标牌（平台中央，两行）
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(74,222,128,0.92)';
    c.font = `700 ${Math.round(cs * 0.5)}px system-ui, sans-serif`;
    c.fillText('DROP', x + w / 2, y + h * 0.40);
    c.fillStyle = 'rgba(148,163,184,0.8)';
    c.font = `${Math.round(cs * 0.32)}px system-ui, sans-serif`;
    c.fillText('卸货区', x + w / 2, y + h * 0.63);
  }

  /* ============================================================
   * 动态层：每帧绘制
   * ============================================================ */

  /** 每帧入口：静态层 + 环境动效（后续版本在此叠加机器人等） */
  render(t) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cssW, this.cssH);
    c.drawImage(this.staticLayer, 0, 0, this.cssW, this.cssH);
    this.drawAmbientFx(c, t);
  }

  /** 环境动效：卸货区脉冲光圈 + 主站呼吸光晕 */
  drawAmbientFx(c, t) {
    const cs = this.cs;
    const zoneRing = (z, pad, color, alpha, blur) => {
      const x = this.px(z.x0) - pad, y = this.py(z.y0) - pad;
      const w = (z.x1 - z.x0 + 1) * cs + pad * 2;
      const h = (z.y1 - z.y0 + 1) * cs + pad * 2;
      c.save();
      c.shadowColor = color;
      c.shadowBlur = blur;
      c.strokeStyle = color;
      c.globalAlpha = alpha;
      c.lineWidth = 1.6;
      rr(c, x, y, w, h, Math.max(8, cs * 0.3) + pad);
      c.stroke();
      c.restore();
    };

    // 卸货区：脉冲呼吸
    const p1 = 0.5 + 0.5 * Math.sin(t / 780);
    zoneRing(CFG.DROP, 5 + 4 * p1, 'rgba(34,197,94,0.9)', 0.10 + 0.17 * p1, 16);

    // 主站：更慢、更淡的呼吸
    const p2 = 0.5 + 0.5 * Math.sin(t / 1500 + 2.1);
    zoneRing(CFG.HOME, 4 + 3 * p2, 'rgba(59,130,246,0.9)', 0.07 + 0.11 * p2, 14);
  }
}

/* ---------------- 启动 ---------------- */
(function boot() {
  const grid = new Grid();
  const canvas = document.getElementById('cv');
  const renderer = new Renderer(canvas, grid);

  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(canvas.parentElement);
  }
  renderer.resize();

  // 渲染循环：逻辑（v0.2 起）与渲染分离，此处仅渲染
  function frame(t) {
    // 跨屏拖动等场景 DPR 变化时重建
    if ((window.devicePixelRatio || 1) !== renderer.dpr) renderer.resize();
    renderer.render(t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
