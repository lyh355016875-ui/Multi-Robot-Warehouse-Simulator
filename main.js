'use strict';
/* ============================================================
 * 多机器人智能仓库仿真 · main.js
 * 当前版本 v0.2.0 — 单机器人取送货
 *
 * 架构：
 *   - 逻辑（Simulation.update）与渲染（Renderer.render）分离，
 *     requestAnimationFrame 单循环驱动
 *   - 静态层（地板、网格、货架、主站、卸货区）预渲染到离屏 Canvas；
 *     动态层（路径、货物、机器人）每帧绘制
 *   - 高 DPI：backing store = CSS 尺寸 × devicePixelRatio，
 *     resize / DPR 变化时自动重建静态层
 *
 * 模块：CFG / utils / Grid / PathPlanner(A*) / Cargo / Robot /
 *       Simulation / Renderer / boot
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

  // 货物包装色板（中饱和、彼此和谐）；货物位于随机货架格
  CARGO_COLORS: ['#F59E0B', '#10B981', '#8B5CF6', '#EC4899',
                 '#06B6D4', '#84CC16', '#F97316', '#6366F1'],

  PAL: {
    pageBg: '#0B1220',
    outside: '#0A0F1C',
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

  MOVE_MS: 320,          // 基准：每格移动耗时（250~400ms 区间中值）
  TURN_MS: 160,          // 转向平滑常数
};

/* ---------------- 通用工具 ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** 确定性随机（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 角度归一化到 (-π, π] */
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** 回弹缓动（障碍弹入动画用） */
function easeOutBack(t) {
  const c = 1.70158;
  t -= 1;
  return 1 + (c + 1) * t * t * t + c * t * t;
}

/** 颜色调节：k>0 变亮、k<0 变暗，返回 rgb() 字符串 */
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (k >= 0) {
    r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
  } else {
    r *= (1 + k); g *= (1 + k); b *= (1 + k);
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** hex → rgba() */
function withA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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
    // 动态障碍：key "x,y" → {x, y, born}（born 为放置时刻的仿真毫秒，弹入动画用）
    this.obstacles = new Map();
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

/* ============================================================
 * A* 路径规划器
 * 四方向 + 曼哈顿启发 + 二叉堆开放列表（借鉴 PathFinding.js）
 * blocked：临时不可通行格集合（"x,y" 字符串，v0.3 起传入机器人占用）
 * ============================================================ */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }

  /** n: {f, h}，f 小者先出；f 相同时 h 小者先出（少 tie 抖动） */
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f < a[i].f || (a[p].f === a[i].f && a[p].h <= a[i].h)) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && (a[l].f < a[m].f || (a[l].f === a[m].f && a[l].h < a[m].h))) m = l;
        if (r < a.length && (a[r].f < a[m].f || (a[r].f === a[m].f && a[r].h < a[m].h))) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class PathPlanner {
  constructor(grid) { this.grid = grid; }

  /**
   * 求最短路径。返回 [{x,y}, ...]（不含 start，含 goal）；不可达返回 null。
   */
  findPath(start, goal, blocked) {
    const { COLS, ROWS } = CFG;
    if (start.x === goal.x && start.y === goal.y) return [];
    if (!this.grid.walkable(goal.x, goal.y)) return null;
    if (blocked && blocked.has(`${goal.x},${goal.y}`)) return null;

    const N = COLS * ROWS;
    const g = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const idx = (x, y) => y * COLS + x;
    const hOf = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

    const heap = new MinHeap();
    const sIdx = idx(start.x, start.y);
    g[sIdx] = 0;
    heap.push({ x: start.x, y: start.y, g: 0, f: hOf(start.x, start.y), h: hOf(start.x, start.y) });

    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const goalIdx = idx(goal.x, goal.y);

    while (heap.size > 0) {
      const cur = heap.pop();
      const ci = idx(cur.x, cur.y);
      if (closed[ci]) continue;
      closed[ci] = 1;
      if (ci === goalIdx) break;

      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (!this.grid.walkable(nx, ny)) continue;
        if (blocked && blocked.has(`${nx},${ny}`)) continue;
        const ni = idx(nx, ny);
        if (closed[ni]) continue;
        const ng = g[ci] + 1;
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = ci;
          const h = hOf(nx, ny);
          heap.push({ x: nx, y: ny, g: ng, f: ng + h, h });
        }
      }
    }

    if (came[goalIdx] === -1 && goalIdx !== sIdx) return null;

    // 回溯
    const path = [];
    let i = goalIdx;
    while (i !== sIdx && i !== -1) {
      path.push({ x: i % COLS, y: (i / COLS) | 0 });
      i = came[i];
    }
    path.reverse();
    return path.length > 0 ? path : null;
  }
}

/* ---------------- 货物 ---------------- */
class Cargo {
  constructor(id, x, y, color) {
    this.id = id;
    this.x = x; this.y = y;
    this.color = color;
    this.assignedTo = null;   // 已分配的机器人 id（null = 未分配）
    this.collected = false;   // 已被取走（地面消失，随机器人移动）
    this.delivered = false;   // 已送达
  }
}

/* ---------------- 机器人 ---------------- */
const RS = {
  IDLE: 'idle',
  TO_PICKUP: 'toPickup',
  CARRYING: 'carrying',
  WAITING: 'waiting',        // v0.3 起使用
  REPLANNING: 'replanning',  // v0.4 起使用
};

class Robot {
  constructor(id, gx, gy) {
    this.id = id;
    this.gx = gx; this.gy = gy;        // 当前逻辑格
    this.fromX = gx; this.fromY = gy;  // 当前移动步起点
    this.toX = gx; this.toY = gy;      // 当前移动步终点
    this.moving = false;
    this.moveT = 0;                    // 当前步进度 0..1
    this.leftover = 0;                 // 跨步剩余时间（保持速度连续）
    this.angle = -Math.PI / 2;         // 初始朝上
    this.targetAngle = this.angle;
    this.state = RS.IDLE;              // 展示状态（含 waiting）
    this.taskState = RS.IDLE;          // 实际任务状态（waiting 恢复的目标）
    this.path = [];                    // 剩余路径 [{x,y}, ...]
    this.cargo = null;                 // 已接单 / 载运的货物
    this.color = CFG.ROBOT_COLORS[id % CFG.ROBOT_COLORS.length];
    this.blockedMs = 0;                // 连续受阻时长（仿真毫秒，死锁解除用）
    this.replanCooldown = 0;           // 规划失败冷却（防止高频重试 A*）
    this.needReplan = false;           // 障碍阻断路径，待本步完成后重规划
    this.replanFlashUntil = 0;         // REPLANNING 闪烁提示截止时刻（仿真毫秒）
  }

  /** 渲染插值位置（浮点格坐标） */
  renderPos() {
    if (!this.moving) return { x: this.gx, y: this.gy };
    return {
      x: lerp(this.fromX, this.toX, this.moveT),
      y: lerp(this.fromY, this.toY, this.moveT),
    };
  }

  beginStep() {
    const n = this.path[0];
    this.fromX = this.gx; this.fromY = this.gy;
    this.toX = n.x; this.toY = n.y;
    this.moving = true;
    const dx = this.toX - this.fromX, dy = this.toY - this.fromY;
    if (dx !== 0 || dy !== 0) this.targetAngle = Math.atan2(dy, dx);
  }

  finishStep() {
    this.gx = this.toX; this.gy = this.toY;
    this.path.shift();
  }

  /** 逻辑格占用：移动中占 from + to 两格（物理上处于两格之间） */
  occupiedCells() {
    return this.moving
      ? [[this.gx, this.gy], [this.toX, this.toY]]
      : [[this.gx, this.gy]];
  }

  /* ---- 每帧三段式：移动 → 决策 → 转向 ----
   * 决策轮由 Simulation 统一按 id 顺序调度，等同"定点迭代解析器"：
   * 前序机器人完成一步后释放的格子，同帧内后序机器人立即可用。 */

  updateMove(dt, sim) {
    if (!this.moving) return;
    this.moveT += (dt * sim.speedMult) / CFG.MOVE_MS;
    if (this.moveT >= 1) {
      this.leftover = this.moveT - 1;
      this.finishStep();
      this.moving = false;
    }
  }

  updateDecision(dt, sim) {
    if (this.replanCooldown > 0) this.replanCooldown -= dt;
    // REPLANNING 闪烁期结束 → 恢复任务显示状态
    if (this.state === RS.REPLANNING && sim.elapsed > this.replanFlashUntil) {
      this.state = this.taskState;
    }
    if (this.moving) { this.blockedMs = 0; return; }

    // 障碍阻断路径（移动中标记的）：本步走完后立即重规划
    if (this.needReplan) {
      this.needReplan = false;
      this.replanNow(sim);
    }

    if (this.path.length === 0) this.onArrive(sim);
    if (this.path.length === 0) return;

    const next = this.path[0];
    // 兜底：路径含障碍格（正常应已被 onObstaclesChanged 处理）
    if (!sim.grid.walkable(next.x, next.y)) {
      this.replanNow(sim);
      return;
    }
    const occ = sim.occupiedBy(next.x, next.y, this);
    if (!occ) {
      // 格子空闲：进入（消耗上一格的溢出时间，速度连续）
      this.beginStep();
      this.moveT = this.leftover;
      this.leftover = 0;
      if (this.state === RS.WAITING) this.state = this.taskState;
      this.blockedMs = 0;
      return;
    }

    // 目标格被占：等待
    if (this.taskState !== RS.IDLE) this.state = RS.WAITING;
    this.blockedMs += dt * sim.speedMult;

    // 头对头死锁：对方静止、且想来我的当前格 → 低 id 优先，我立即让位
    // （对方 id 更大时，它自己的决策轮会检测并让位，我保持等待即可）
    if (!occ.moving && occ.path[0] &&
        occ.path[0].x === this.gx && occ.path[0].y === this.gy &&
        occ.id < this.id) {
      sim.yieldRobot(this);
      return;
    }
    // 错峰超时让位：阈值按 id 错开，避免所有机器人同时让位造成二次拥堵
    if (this.blockedMs >= (6 + this.id % 4) * CFG.MOVE_MS) sim.yieldRobot(this);
  }

  updateTurn(dt) {
    const da = wrapAngle(this.targetAngle - this.angle);
    if (Math.abs(da) < 0.02) this.angle = this.targetAngle;
    else this.angle = wrapAngle(this.angle + da * Math.min(1, dt / CFG.TURN_MS));
  }

  /* ---- 任务逻辑 ---- */

  /** 空闲：认领最近未分配货物（按拣货位距离），规划到拣货位 */
  onIdle(sim) {
    if (this.replanCooldown > 0) return;

    // 当前格被用户放置障碍（宽限机制）：先挪到最近空闲格，"下一步必须离开"
    if (!sim.grid.walkable(this.gx, this.gy)) {
      const goal = sim.findFreeCellNear(this.gx, this.gy, this);
      if (goal) {
        const p = sim.planner.findPath({ x: this.gx, y: this.gy }, goal, sim.blockedFor(this));
        if (p && p.length) {
          this.path = p;
          this.state = RS.REPLANNING;
          this.replanFlashUntil = sim.elapsed + 900;
          return;
        }
      }
      this.replanCooldown = 400;
      return;
    }

    let best = null, bCell = null, bd = Infinity;
    for (const c of sim.cargos) {
      if (c.assignedTo !== null || c.collected) continue;
      const cell = sim.bestPickupCell(c, this.gx, this.gy, this);
      if (!cell) continue;
      const d = Math.abs(cell.x - this.gx) + Math.abs(cell.y - this.gy);
      if (d < bd) { bd = d; best = c; bCell = cell; }
    }
    if (!best) return;
    const p = sim.planner.findPath({ x: this.gx, y: this.gy }, bCell, sim.blockedFor(this));
    if (!p) { this.replanCooldown = 300; return; }
    best.assignedTo = this.id;
    this.cargo = best;
    this.taskState = this.state = RS.TO_PICKUP;
    this.path = p;
  }

  /** 到达终点 / 路径耗尽的统一入口（也承担规划失败后的重试） */
  onArrive(sim) {
    if (this.taskState === RS.TO_PICKUP) {
      const c = this.cargo;
      if (c && !c.collected && sim.isAdjacent(this.gx, this.gy, c)) {
        c.collected = true;                          // 货物从货架消失
        this.taskState = this.state = RS.CARRYING;
      }
      if (this.taskState === RS.CARRYING) this.planDrop(sim);
      else this.planPickup(sim);
    } else if (this.taskState === RS.CARRYING) {
      if (sim.inDrop(this.gx, this.gy)) {
        const c = this.cargo;
        if (c) c.delivered = true;
        this.cargo = null;
        sim.delivered++;
        this.taskState = this.state = RS.IDLE;
        this.onIdle(sim);                            // 立即尝试接下一单
      } else {
        this.planDrop(sim);
      }
    } else {
      this.onIdle(sim);
    }
  }

  /** 立即重规划（障碍阻断触发）：跳过冷却，闪烁提示 900ms */
  replanNow(sim) {
    this.replanCooldown = 0;
    this.state = RS.REPLANNING;
    this.replanFlashUntil = sim.elapsed + 900;
    if (this.taskState === RS.TO_PICKUP) this.planPickup(sim);
    else if (this.taskState === RS.CARRYING) this.planDrop(sim);
    else this.onIdle(sim);
  }

  planPickup(sim) {
    if (this.replanCooldown > 0) return;
    const c = this.cargo;
    if (!c || c.collected) { this.abandonTask(); return; }
    const cell = sim.bestPickupCell(c, this.gx, this.gy, this);
    if (!cell || (cell.x === this.gx && cell.y === this.gy)) {
      // 无可用拣货位：区分"暂时被机器人占"与"被障碍围死"
      const anyNbr = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy }))
        .find(p => sim.grid.walkable(p.x, p.y));
      if (!anyNbr || !sim.planner.findPath({ x: this.gx, y: this.gy }, anyNbr, null)) {
        this.abandonTask();               // 货物被障碍围死，放弃转投其他任务
      } else {
        this.replanCooldown = 300;        // 暂时被占，稍后重试
      }
      return;
    }
    const p = sim.planner.findPath({ x: this.gx, y: this.gy }, cell, sim.blockedFor(this));
    if (p && p.length) { this.path = p; return; }
    // 规划失败：路线被机器人挡（暂时）或被障碍堵死（永久）
    if (!sim.planner.findPath({ x: this.gx, y: this.gy }, cell, null)) {
      this.abandonTask();
    } else {
      this.replanCooldown = 300;
    }
  }

  planDrop(sim) {
    if (this.replanCooldown > 0) return;
    const goal = sim.nearestDropCell(this.gx, this.gy, this);
    if (!goal) { this.replanCooldown = 300; return; }
    const p = sim.planner.findPath({ x: this.gx, y: this.gy }, goal, sim.blockedFor(this));
    if (p) this.path = p;
    else this.replanCooldown = 300;
  }

  abandonTask() {
    if (this.cargo) { this.cargo.assignedTo = null; this.cargo = null; }
    this.taskState = this.state = RS.IDLE;
    this.path = [];
    this.replanCooldown = 200;
  }
}

/* ---------------- 仿真调度 ---------------- */
class Simulation {
  constructor(grid) {
    this.grid = grid;
    this.planner = new PathPlanner(grid);
    this.robots = [];
    this.cargos = [];
    this.delivered = 0;
    this.elapsed = 0;         // 累计运行毫秒
    this.speedMult = 1;       // 速度倍率（滑块控制）
    this.paused = false;      // 暂停标志（暂停时可编辑障碍，时间冻结）
    this.collisions = 0;      // 碰撞守卫计数（必须恒为 0）
    this.rng = mulberry32(7); // 随机源（重置时换种子）

    // 三个机器人，主站停车位出发
    this.addRobot(2, 13);
    this.addRobot(3, 13);
    this.addRobot(4, 13);
    this.spawnRandomCargos();
  }

  /** 随机生成货物：8~12 个，位于随机货架格（保证至少一个可用拣货位） */
  spawnRandomCargos(fixedCount) {
    const spots = [];
    for (const s of CFG.SHELVES)
      for (let y = s.y0; y <= s.y1; y++)
        for (let x = s.x0; x <= s.x1; x++) spots.push([x, y]);
    // Fisher-Yates 洗牌
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const n = fixedCount || 8 + Math.floor(this.rng() * 5);   // 8~12
    const chosen = [];
    for (const [x, y] of spots) {
      if (chosen.length >= n) break;
      const reachable = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dy]) => this.grid.walkable(x + dx, y + dy));
      if (reachable) chosen.push([x, y]);
    }
    this.cargos = chosen.map(([x, y], i) => new Cargo(
      i + 1, x, y,
      CFG.CARGO_COLORS[Math.floor(this.rng() * CFG.CARGO_COLORS.length)],
    ));

    // 清空所有机器人任务（载货中的货物随之消失），原地重新接单
    for (const r of this.robots) {
      r.cargo = null;
      r.path = [];
      r.state = RS.IDLE;
      r.taskState = RS.IDLE;
      r.needReplan = false;
      r.blockedMs = 0;
      r.replanCooldown = 0;
      if (r.moving) {          // 立即完成当前步，避免悬在半格
        r.gx = r.toX; r.gy = r.toY;
        r.moving = false; r.moveT = 0; r.leftover = 0;
      }
    }
    this.delivered = 0;
  }

  /** 重置仿真：清障碍、机器人回主站、随机新货物、计时归零 */
  reset() {
    this.grid.rebuild();
    this.robots = [];
    this.addRobot(2, 13);
    this.addRobot(3, 13);
    this.addRobot(4, 13);
    this.delivered = 0;
    this.elapsed = 0;
    this.collisions = 0;
    this.paused = false;
    this.rng = mulberry32((Date.now() & 0x7fffffff) >>> 0);   // 每次重置换新种子
    this.spawnRandomCargos();
  }

  /** 增加机器人：优先主站停车位 → 主站任意空闲格；上限 8 */
  addRobotAuto() {
    if (this.robots.length >= CFG.MAX_ROBOTS) return null;
    const occupied = new Set(this.robots.map(r => `${r.gx},${r.gy}`));
    const candidates = [];
    for (let i = 0; i < 3; i++) candidates.push([CFG.HOME.x0 + 1 + i, CFG.HOME.y0]);   // 停车位
    for (let y = CFG.HOME.y1; y >= CFG.HOME.y0; y--)                                   // 主站其余格
      for (let x = CFG.HOME.x0; x <= CFG.HOME.x1; x++) candidates.push([x, y]);
    for (const [x, y] of candidates) {
      if (!occupied.has(`${x},${y}`) && this.grid.walkable(x, y)) return this.addRobot(x, y);
    }
    return null;
  }

  addRobot(x, y) {
    const r = new Robot(this.robots.length, x, y);
    this.robots.push(r);
    return r;
  }

  /* ---- 动态障碍 ---- */

  /** 可否在 (x,y) 放置障碍：仅通道地板；移动中机器人的 from/to 格禁放
   *  （刹不住），静止机器人的当前格允许（宽限机制：下一步必须离开） */
  canPlaceObstacle(x, y) {
    if (this.grid.at(x, y) !== CELL.FLOOR) return false;
    for (const r of this.robots) {
      if (r.moving && ((r.gx === x && r.gy === y) || (r.toX === x && r.toY === y))) {
        return false;
      }
    }
    return true;
  }

  placeObstacle(x, y) {
    if (!this.canPlaceObstacle(x, y)) return false;
    this.grid.cells[y][x] = CELL.OBST;
    // born 用真实时间：暂停时弹入动画照常播完（仿真时间冻结）
    this.grid.obstacles.set(`${x},${y}`, { x, y, born: performance.now() });
    this.onObstaclesChanged();
    return true;
  }

  removeObstacle(x, y) {
    if (this.grid.at(x, y) !== CELL.OBST) return false;
    this.grid.cells[y][x] = CELL.FLOOR;
    this.grid.obstacles.delete(`${x},${y}`);
    this.onObstaclesChanged();
    return true;
  }

  /** 障碍变更：所有机器人立即检测路径阻断并重规划；等待者解除冷却重试 */
  onObstaclesChanged() {
    for (const r of this.robots) {
      r.replanCooldown = 0;
      r.blockedMs = 0;
      let broken = false;
      for (const cell of r.path) {
        if (!this.grid.walkable(cell.x, cell.y)) { broken = true; break; }
      }
      if (broken) {
        if (r.moving) r.needReplan = true;   // 本步走完后重规划（to 格禁放障碍，安全）
        else r.replanNow(this);
      } else if (r.path.length === 0 && r.taskState !== RS.IDLE) {
        r.replanNow(this);                   // 等待重试的任务机器人：立即重试
      }
    }
  }

  /** BFS 搜索距 (x,y) 最近的空闲可通行格（可穿越障碍扩展） */
  findFreeCellNear(x, y, robot) {
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const q = [[x, y]];
    const seen = new Set([`${x},${y}`]);
    while (q.length > 0) {
      const [cx, cy] = q.shift();
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        const k = `${nx},${ny}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!this.grid.inBounds(nx, ny)) continue;
        if (this.grid.walkable(nx, ny) && !this.occupiedBy(nx, ny, robot)) {
          return { x: nx, y: ny };
        }
        q.push([nx, ny]);
      }
    }
    return null;
  }

  /* ---- 占用与通行 ---- */

  /** (x,y) 被哪个机器人占用（移动中占 from+to 两格），except 除外 */
  occupiedBy(x, y, except) {
    for (const r of this.robots) {
      if (r === except) continue;
      if (r.moving) {
        if ((r.gx === x && r.gy === y) || (r.toX === x && r.toY === y)) return r;
      } else if (r.gx === x && r.gy === y) return r;
    }
    return null;
  }

  /** 其他机器人的占用格集合（A* 规划时视为墙） */
  blockedFor(robot) {
    const s = new Set();
    for (const o of this.robots) {
      if (o === robot) continue;
      s.add(`${o.gx},${o.gy}`);
      if (o.moving) s.add(`${o.toX},${o.toY}`);
    }
    return s;
  }

  /** (x,y) 是否与货物相邻（拣货判定） */
  isAdjacent(x, y, cargo) {
    return Math.abs(x - cargo.x) + Math.abs(y - cargo.y) === 1;
  }

  /** (x,y) 是否在卸货区内 */
  inDrop(x, y) {
    const z = CFG.DROP;
    return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  }

  /** 货物的最佳拣货位：相邻可通行格中未被占用、离 (fx,fy) 最近者 */
  bestPickupCell(cargo, fx, fy, robot) {
    let best = null, bd = Infinity;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cargo.x + dx, y = cargo.y + dy;
      if (!this.grid.walkable(x, y)) continue;
      if (robot && this.occupiedBy(x, y, robot)) continue;
      const d = Math.abs(x - fx) + Math.abs(y - fy);
      if (d < bd) { bd = d; best = { x, y }; }
    }
    return best;
  }

  /** 距离 (x,y) 最近的空闲卸货格 */
  nearestDropCell(x, y, robot) {
    const z = CFG.DROP;
    let best = null, bd = Infinity;
    for (let cy = z.y0; cy <= z.y1; cy++) {
      for (let cx = z.x0; cx <= z.x1; cx++) {
        if (!this.grid.walkable(cx, cy)) continue;
        if (robot && this.occupiedBy(cx, cy, robot)) continue;
        const d = Math.abs(cx - x) + Math.abs(cy - y);
        if (d < bd) { bd = d; best = { x: cx, y: cy }; }
      }
    }
    return best;
  }

  /** 机器人当前任务目标（让位后重新规划用） */
  taskGoal(r) {
    if (r.taskState === RS.TO_PICKUP && r.cargo) {
      return this.bestPickupCell(r.cargo, r.gx, r.gy, r);
    }
    if (r.taskState === RS.CARRYING) return this.nearestDropCell(r.gx, r.gy, r);
    return null;
  }

  /** 死锁解除：侧移到随机空闲邻格，并重新规划回任务目标 */
  yieldRobot(r) {
    if (r.moving) return;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const start = Math.floor(this.rng() * 4);   // 随机起点，避免集体同向让位
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = dirs[(start + i) % 4];
      const x = r.gx + dx, y = r.gy + dy;
      if (!this.grid.walkable(x, y)) continue;
      if (this.occupiedBy(x, y, r)) continue;
      const goal = this.taskGoal(r);
      const rest = goal ? this.planner.findPath({ x, y }, goal, this.blockedFor(r)) : null;
      r.path = rest ? [{ x, y }, ...rest] : [{ x, y }];
      r.blockedMs = 0;
      return;
    }
    r.blockedMs = -CFG.MOVE_MS * 2;   // 无处可让，延后重试
  }

  /** 碰撞守卫：逻辑格互斥，出现重叠立即报错（必须恒为 0） */
  checkCollisions() {
    const seen = new Map();
    for (const r of this.robots) {
      for (const [x, y] of r.occupiedCells()) {
        const k = x + ',' + y;
        if (seen.has(k)) {
          this.collisions++;
          console.error(`[碰撞守卫] 机器人 #${seen.get(k)} 与 #${r.id} 重叠于 (${x},${y})`);
        } else {
          seen.set(k, r.id);
        }
      }
    }
  }

  update(dt) {
    if (this.paused) return;
    this.elapsed += dt;
    // 三段式调度：决策轮按 id 顺序，前序机器人释放的格子同帧可用（链式前进）
    for (const r of this.robots) r.updateMove(dt, this);
    for (const r of this.robots) r.updateDecision(dt, this);
    for (const r of this.robots) r.updateTurn(dt);
    this.checkCollisions();
  }

  get allDelivered() {
    return this.cargos.length > 0 && this.cargos.every(c => c.delivered);
  }
  get remainingCargo() {
    return this.cargos.filter(c => !c.collected && !c.delivered).length;
  }
}

/* ---------------- 渲染器 ---------------- */
class Renderer {
  constructor(canvas, grid, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.grid = grid;
    this.sim = sim;
    this.dpr = 0;
    this.cs = 32;
    this.ox = 0; this.oy = 0;
    this.gw = 0; this.gh = 0;
    this.staticLayer = document.createElement('canvas');
    this.hoverCell = null;    // 鼠标悬停格（提示用）
    this.painting = null;     // 按住拖动模式：'add' | 'remove'
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
  /** 浮点格坐标 → 像素中心 */
  cx(x) { return this.ox + x * this.cs + this.cs / 2; }
  cy(y) { return this.oy + y * this.cs + this.cs / 2; }

  /* ============================================================
   * 鼠标交互：左键放置 / 右键移除障碍，按住可拖动连续绘制
   * ============================================================ */
  cellFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - this.ox;
    const y = e.clientY - rect.top - this.oy;
    if (x < 0 || y < 0 || x >= this.gw || y >= this.gh) return null;
    return { x: Math.floor(x / this.cs), y: Math.floor(y / this.cs) };
  }

  bindInput() {
    const cv = this.canvas;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('mousedown', e => {
      const cell = this.cellFromEvent(e);
      if (!cell) return;
      if (e.button === 0) {
        this.painting = 'add';
        this.sim.placeObstacle(cell.x, cell.y);
      } else if (e.button === 2) {
        this.painting = 'remove';
        this.sim.removeObstacle(cell.x, cell.y);
      }
    });
    cv.addEventListener('mousemove', e => {
      this.hoverCell = this.cellFromEvent(e);
      if (!this.hoverCell || !this.painting) return;
      if (this.painting === 'add') this.sim.placeObstacle(this.hoverCell.x, this.hoverCell.y);
      else this.sim.removeObstacle(this.hoverCell.x, this.hoverCell.y);
    });
    window.addEventListener('mouseup', () => { this.painting = null; });
    cv.addEventListener('mouseleave', () => { this.hoverCell = null; });
  }

  /* ============================================================
   * 静态层：一次性绘制，resize 时重建
   * ============================================================ */
  buildStaticLayer() {
    const s = this.staticLayer;
    s.width = this.canvas.width;
    s.height = this.canvas.height;
    const c = s.getContext('2d');
    c.scale(this.dpr, this.dpr);

    c.fillStyle = CFG.PAL.outside;
    c.fillRect(0, 0, this.cssW, this.cssH);

    c.save();
    c.shadowColor = 'rgba(0,0,0,0.55)';
    c.shadowBlur = 28;
    c.shadowOffsetY = 8;
    rr(c, this.ox, this.oy, this.gw, this.gh, 12);
    c.fillStyle = CFG.PAL.floor;
    c.fill();
    c.restore();

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
      const n = (rnd() - 0.5) * 2;
      const v = n > 0 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = Math.floor(Math.abs(n) * 12);
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
    const mid = (z) => ({ x: this.cx((z.x0 + z.x1 + 1) / 2), y: this.cy((z.y0 + z.y1 + 1) / 2) });
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
    const depth = Math.max(3, Math.round(cs * 0.14));
    const rad = Math.max(5, Math.round(cs * 0.18));

    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 14;
    c.shadowOffsetY = 5;
    rr(c, x + 1, y + 1, w - 2, h - 2, rad);
    c.fillStyle = CFG.PAL.shelfSide;
    c.fill();
    c.restore();

    const topH = h - depth;
    const g = c.createLinearGradient(0, y, 0, y + topH);
    g.addColorStop(0, '#2E4059');
    g.addColorStop(1, CFG.PAL.shelfTop);
    rr(c, x, y, w, topH, rad);
    c.fillStyle = g;
    c.fill();

    c.strokeStyle = CFG.PAL.shelfHi;
    c.lineWidth = 1;
    rr(c, x + 0.5, y + 0.5, w - 1, topH - 1, rad);
    c.stroke();

    const bays = (s.x1 - s.x0 + 1) / 2;
    for (let i = 0; i < bays; i++) {
      const bx = x + i * 2 * cs;
      const bw = 2 * cs;

      c.strokeStyle = CFG.PAL.shelfBeam;
      c.lineWidth = 1.5;
      c.beginPath();
      for (const f of [0.34, 0.68]) {
        const ly = y + topH * f;
        c.moveTo(bx + 5, ly); c.lineTo(bx + bw - 5, ly);
      }
      c.stroke();

      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      c.fillStyle = 'rgba(148,163,184,0.62)';
      c.font = `600 ${Math.max(9, Math.round(cs * 0.27))}px system-ui, sans-serif`;
      c.fillText(`${s.row}${i + 1}`, bx + 5, y + Math.max(11, topH * 0.27));
    }

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

    c.setLineDash([5, 4]);
    c.strokeStyle = 'rgba(59,130,246,0.42)';
    c.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      const sx = this.px(z.x0 + 1 + i) + 5, sy = this.py(z.y0) + 5;
      rr(c, sx, sy, cs - 10, cs - 10, 6);
      c.stroke();
    }
    c.setLineDash([]);

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
  render(t) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cssW, this.cssH);
    c.drawImage(this.staticLayer, 0, 0, this.cssW, this.cssH);
    this.drawAmbientFx(c, t);
    this.drawObstacles(c);
    this.drawPaths(c, t);
    this.drawCargos(c);
    this.drawRobots(c);
    this.drawHover(c);
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

    const p1 = 0.5 + 0.5 * Math.sin(t / 780);
    zoneRing(CFG.DROP, 5 + 4 * p1, 'rgba(34,197,94,0.9)', 0.10 + 0.17 * p1, 16);

    const p2 = 0.5 + 0.5 * Math.sin(t / 1500 + 2.1);
    zoneRing(CFG.HOME, 4 + 3 * p2, 'rgba(59,130,246,0.9)', 0.07 + 0.11 * p2, 14);
  }

  /** 障碍物：俯视警示桶（橙白扇形条纹），260ms 弹入动画 */
  drawObstacles(c) {
    for (const ob of this.grid.obstacles.values()) {
      const cx = this.cx(ob.x), cy = this.cy(ob.y);
      const cs = this.cs;
      const age = performance.now() - ob.born;
      const k = age >= 260 ? 1 : Math.max(0.01, easeOutBack(clamp(age / 260, 0, 1)));

      c.save();
      c.translate(cx, cy);
      c.scale(k, k);

      // 阴影
      c.fillStyle = 'rgba(0,0,0,0.4)';
      c.beginPath();
      c.ellipse(1.5, cs * 0.13, cs * 0.33, cs * 0.25, 0, 0, Math.PI * 2);
      c.fill();

      const R = cs * 0.36;
      // 桶身深色外圈
      c.beginPath();
      c.arc(0, 0, R, 0, Math.PI * 2);
      c.fillStyle = '#9A3412';
      c.fill();
      // 橙白警示扇形（桶盖）
      for (let i = 0; i < 8; i++) {
        const a0 = i * Math.PI / 4 - Math.PI / 8, a1 = a0 + Math.PI / 4;
        c.beginPath();
        c.moveTo(0, 0);
        c.arc(0, 0, R - 1.5, a0, a1);
        c.closePath();
        c.fillStyle = i % 2 === 0 ? '#F97316' : '#F8FAFC';
        c.fill();
      }
      // 中心深色圆点
      c.beginPath();
      c.arc(0, 0, R * 0.22, 0, Math.PI * 2);
      c.fillStyle = '#7C2D12';
      c.fill();
      // 高光弧
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(0, 0, R - 2, -Math.PI * 0.9, -Math.PI * 0.45);
      c.stroke();
      c.restore();
    }
  }

  /** 悬停指示：可放置格淡橙虚线框；障碍格红框（提示右键移除） */
  drawHover(c) {
    const h = this.hoverCell;
    if (!h || this.painting) return;
    const x = this.px(h.x), y = this.py(h.y);
    const s = this.cs;
    if (this.grid.at(h.x, h.y) === CELL.OBST) {
      c.strokeStyle = 'rgba(248,113,113,0.75)';
      c.lineWidth = 2;
      rr(c, x + 2, y + 2, s - 4, s - 4, 6);
      c.stroke();
    } else if (this.sim.canPlaceObstacle(h.x, h.y)) {
      c.fillStyle = 'rgba(249,115,22,0.13)';
      rr(c, x + 2, y + 2, s - 4, s - 4, 6);
      c.fill();
      c.setLineDash([4, 3]);
      c.strokeStyle = 'rgba(249,115,22,0.55)';
      c.lineWidth = 1.5;
      rr(c, x + 2, y + 2, s - 4, s - 4, 6);
      c.stroke();
      c.setLineDash([]);
    }
  }

  /** 路径：机器人色 30% 透明度虚线折线，随速度流动；重规划时高频闪烁 */
  drawPaths(c, t) {
    for (const r of this.sim.robots) {
      if (!r.moving && r.path.length === 0) continue;
      const p0 = r.renderPos();
      const pts = [p0, ...r.path];

      let alpha = 0.30;
      if (r.state === RS.REPLANNING) {
        alpha = 0.30 * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 55)));
      }

      c.save();
      c.strokeStyle = withA(r.color, alpha);
      c.lineWidth = 2;
      c.setLineDash([7, 6]);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      // 虚线沿行进方向流动，速度与机器人速度倍率关联
      c.lineDashOffset = -(this.sim.elapsed / 45) * this.sim.speedMult;
      c.beginPath();
      c.moveTo(this.cx(pts[0].x), this.cy(pts[0].y));
      for (let i = 1; i < pts.length; i++) c.lineTo(this.cx(pts[i].x), this.cy(pts[i].y));
      c.stroke();
      c.setLineDash([]);

      // 终点标记：半透明小圆
      const last = pts[pts.length - 1];
      c.fillStyle = withA(r.color, 0.35);
      c.beginPath();
      c.arc(this.cx(last.x), this.cy(last.y), this.cs * 0.10, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  /** 货架上的货物：带包装带的小箱子（绘制位置向货架厚度中心微收） */
  drawCargos(c) {
    for (const cargo of this.sim.cargos) {
      if (cargo.collected || cargo.delivered) continue;
      const cs = this.cs;
      const cx = this.cx(cargo.x);
      let cy = this.cy(cargo.y);
      for (const sh of CFG.SHELVES) {
        if (cargo.x >= sh.x0 && cargo.x <= sh.x1 && cargo.y >= sh.y0 && cargo.y <= sh.y1) {
          const midY = (sh.y0 + sh.y1 + 1) / 2;
          cy = this.cy(cargo.y + clamp(midY - cargo.y, -0.2, 0.2));
          break;
        }
      }
      const s = cs * 0.44;

      // 外圈提示环
      c.strokeStyle = withA(cargo.color, 0.28);
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(cx, cy, s * 0.82, 0, Math.PI * 2);
      c.stroke();

      // 阴影
      c.fillStyle = 'rgba(0,0,0,0.32)';
      c.beginPath();
      c.ellipse(cx, cy + s * 0.42, s * 0.52, s * 0.2, 0, 0, Math.PI * 2);
      c.fill();

      // 箱体（轻微渐变）
      const g = c.createLinearGradient(cx, cy - s / 2, cx, cy + s / 2);
      g.addColorStop(0, shade(cargo.color, 0.28));
      g.addColorStop(1, shade(cargo.color, -0.18));
      rr(c, cx - s / 2, cy - s / 2, s, s, 3.5);
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 1;
      c.stroke();

      // 包装带（十字）
      c.strokeStyle = 'rgba(15,23,42,0.5)';
      c.lineWidth = Math.max(2, s * 0.14);
      c.beginPath();
      c.moveTo(cx, cy - s / 2 + 1); c.lineTo(cx, cy + s / 2 - 1);
      c.moveTo(cx - s / 2 + 1, cy); c.lineTo(cx + s / 2 - 1, cy);
      c.stroke();

      // 左上高光
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(cx - s / 2 + 3, cy - s / 2 + s * 0.32);
      c.lineTo(cx - s / 2 + 3, cy - s / 2 + 3);
      c.lineTo(cx - s / 2 + s * 0.32, cy - s / 2 + 3);
      c.stroke();
    }
  }

  /** 机器人：阴影 → 轮子 → 金属底盘 → 托盘/载货 → 方向三角 → 状态灯 */
  drawRobots(c) {
    for (const r of this.sim.robots) this.drawRobot(c, r);
  }

  drawRobot(c, r) {
    const cs = this.cs;
    const p = r.renderPos();
    const cx = this.cx(p.x), cy = this.cy(p.y);
    const R = cs * 0.36;   // 底盘半径

    // 柔和阴影（方向固定向下）
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath();
    c.ellipse(cx + 1.5, cy + R * 0.55, R * 0.95, R * 0.55, 0, 0, Math.PI * 2);
    c.fill();

    c.save();
    c.translate(cx, cy);
    c.rotate(r.angle);

    // 四轮（长边沿行进方向）
    const wheelW = R * 0.52, wheelH = R * 0.24;
    c.fillStyle = '#1B2534';
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 1;
    for (const [wx, wy] of [[R * 0.52, -R * 0.72], [R * 0.52, R * 0.72], [-R * 0.52, -R * 0.72], [-R * 0.52, R * 0.72]]) {
      rr(c, wx - wheelW / 2, wy - wheelH / 2, wheelW, wheelH, wheelH / 2);
      c.fill();
      c.stroke();
    }

    // 金属渐变底盘
    const g = c.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.1, 0, 0, R);
    g.addColorStop(0, shade(r.color, 0.5));
    g.addColorStop(0.55, r.color);
    g.addColorStop(1, shade(r.color, -0.38));
    c.beginPath();
    c.arc(0, 0, R, 0, Math.PI * 2);
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.28)';
    c.lineWidth = 1.2;
    c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.beginPath();
    c.arc(0, 0, R + 0.8, 0, Math.PI * 2);
    c.lineWidth = 1;
    c.stroke();

    // 方向指示三角（机头）
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath();
    c.moveTo(R * 0.72, 0);
    c.lineTo(R * 0.34, -R * 0.26);
    c.lineTo(R * 0.34, R * 0.26);
    c.closePath();
    c.fill();

    // 托盘（载货时托盘上叠货物色小箱）
    if (r.cargo && r.state === RS.CARRYING) {
      const ps = R * 0.78;
      rr(c, -ps / 2, -ps / 2, ps, ps, 3);
      c.fillStyle = '#3B4A5F';
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.4)';
      c.lineWidth = 1;
      c.stroke();
      const bs = ps * 0.72;
      rr(c, -bs / 2, -bs / 2, bs, bs, 2.5);
      c.fillStyle = r.cargo.color;
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.3)';
      c.stroke();
      c.strokeStyle = 'rgba(15,23,42,0.5)';
      c.lineWidth = Math.max(1.5, bs * 0.16);
      c.beginPath();
      c.moveTo(0, -bs / 2 + 1); c.lineTo(0, bs / 2 - 1);
      c.moveTo(-bs / 2 + 1, 0); c.lineTo(bs / 2 - 1, 0);
      c.stroke();
    } else {
      // 空托盘描边
      const ps = R * 0.78;
      rr(c, -ps / 2, -ps / 2, ps, ps, 3);
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      c.lineWidth = 1.2;
      c.stroke();
    }
    c.restore();

    // 状态灯（不随角度旋转，位于中心）：空闲绿 / 移动蓝 / 等待黄 / 载货橙 / 重规划青
    const lamp = r.state === RS.IDLE ? '#4ADE80'
      : r.state === RS.WAITING ? '#FACC15'
      : r.state === RS.REPLANNING ? '#22D3EE'
      : r.state === RS.CARRYING ? '#FB923C'
      : '#38BDF8';
    c.save();
    c.shadowColor = lamp;
    c.shadowBlur = 7;
    c.fillStyle = lamp;
    c.beginPath();
    c.arc(cx, cy, R * 0.16, 0, Math.PI * 2);
    c.fill();
    c.restore();

    // 天线环
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(cx, cy, R * 0.34, 0, Math.PI * 2);
    c.stroke();
  }
}

/* ---------------- UI：DOM 面板绑定 / tooltip / 任务完成浮层 ---------------- */
class UI {
  constructor(sim, renderer) {
    this.sim = sim;
    this.renderer = renderer;
    const $ = (id) => document.getElementById(id);
    this.el = {
      robots: $('statRobots'), delivered: $('statDelivered'),
      cargo: $('statCargo'), time: $('statTime'),
      badge: $('runStatus'), stage: $('stage'),
      pause: $('btnPause'), reset: $('btnReset'), cargoBtn: $('btnCargo'),
      robotBtn: $('btnRobot'), speed: $('speedRange'), speedVal: $('speedVal'),
      tooltip: $('tooltip'), overlay: $('doneOverlay'),
      doneStats: $('doneStats'), again: $('btnAgain'),
    };
    this.bind();
    this.updateHud();
  }

  bind() {
    this.el.pause.addEventListener('click', () => {
      this.sim.paused = !this.sim.paused;
      this.updateHud();
    });
    this.el.reset.addEventListener('click', () => { this.sim.reset(); this.updateHud(); });
    this.el.cargoBtn.addEventListener('click', () => { this.sim.spawnRandomCargos(); this.updateHud(); });
    this.el.robotBtn.addEventListener('click', () => { this.sim.addRobotAuto(); this.updateHud(); });
    this.el.again.addEventListener('click', () => { this.sim.spawnRandomCargos(); this.updateHud(); });
    this.el.speed.addEventListener('input', () => {
      this.sim.speedMult = parseFloat(this.el.speed.value);
      this.el.speedVal.textContent = this.sim.speedMult.toFixed(1) + '×';
    });
    this.bindTooltip();
  }

  stateText(r) {
    switch (r.state) {
      case RS.IDLE: return '空闲';
      case RS.TO_PICKUP: return '前往取货';
      case RS.CARRYING: return '载货 → 卸货区';
      case RS.WAITING: return '等待通行';
      case RS.REPLANNING: return '重新规划中';
      default: return r.state;
    }
  }

  /** 悬停格上的机器人（当前格或移动目标格） */
  robotAt(cell) {
    for (const r of this.sim.robots) {
      if (r.gx === cell.x && r.gy === cell.y) return r;
      if (r.moving && r.toX === cell.x && r.toY === cell.y) return r;
    }
    return null;
  }

  bindTooltip() {
    const cv = this.renderer.canvas;
    cv.addEventListener('mousemove', (e) => {
      const cell = this.renderer.cellFromEvent(e);
      let html = null;
      if (cell) {
        const r = this.robotAt(cell);
        if (r) {
          const goal = r.path.length ? r.path[r.path.length - 1] : null;
          html = `<div class="tt-title"><i style="background:${r.color};box-shadow:0 0 6px ${r.color}"></i>机器人 #${r.id}</div>`
            + `<div class="tt-row">状态：${this.stateText(r)}</div>`
            + `<div class="tt-row">载货：${r.cargo ? `货物 #${r.cargo.id}` : '无'}</div>`
            + (goal ? `<div class="tt-row">目标：(${goal.x}, ${goal.y})</div>` : '');
        } else {
          const t = this.sim.grid.at(cell.x, cell.y);
          const label = t === CELL.SHELF ? '货架'
            : t === CELL.HOME ? '主站'
            : t === CELL.DROP ? '卸货区'
            : t === CELL.OBST ? '障碍'
            : '通道';
          const pass = (t === CELL.FLOOR || t === CELL.HOME || t === CELL.DROP) ? '可通行' : '不可通行';
          html = `<div class="tt-title">格子 (${cell.x}, ${cell.y})</div>`
            + `<div class="tt-row">${label} · ${pass}</div>`;
        }
      }
      this.showTooltip(html, e);
    });
    cv.addEventListener('mouseleave', () => this.showTooltip(null, null));
  }

  showTooltip(html, e) {
    const el = this.el.tooltip;
    if (!html) { el.classList.remove('show'); return; }
    el.innerHTML = html;
    el.classList.add('show');
    // 跟随鼠标（右下偏移，出界翻转）
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = el.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  /** HUD + 徽章 + 按钮态 + 任务完成浮层（低频调用） */
  updateHud() {
    const sim = this.sim;
    this.el.robots.textContent = String(sim.robots.length);
    this.el.delivered.textContent = String(sim.delivered);
    this.el.cargo.textContent = String(sim.remainingCargo);
    this.el.time.textContent = this.fmtTime(sim.elapsed);

    const b = this.el.badge;
    if (sim.allDelivered) {
      b.className = 'badge done';
      b.innerHTML = '<i class="pulse-dot"></i>任务完成';
    } else if (sim.paused) {
      b.className = 'badge paused';
      b.innerHTML = '<i class="pulse-dot"></i>已暂停';
    } else {
      b.className = 'badge';
      b.innerHTML = '<i class="pulse-dot"></i>运行中';
    }

    this.el.pause.textContent = sim.paused ? '继续' : '暂停';
    this.el.robotBtn.disabled = sim.robots.length >= CFG.MAX_ROBOTS;
    this.el.stage.classList.toggle('paused', sim.paused);

    const showDone = sim.allDelivered && !sim.paused;
    this.el.overlay.classList.toggle('show', showDone);
    if (showDone) {
      this.el.doneStats.textContent =
        `共 ${sim.cargos.length} 件货物全部送达 · 用时 ${this.fmtTime(sim.elapsed)} · 碰撞 ${sim.collisions}`;
    }
  }
}

/* ---------------- 启动 ---------------- */
(function boot() {
  const grid = new Grid();
  const sim = new Simulation(grid);
  const canvas = document.getElementById('cv');
  const renderer = new Renderer(canvas, grid, sim);
  const ui = new UI(sim, renderer);

  window.__sim = sim;           // 调试 / 自测钩子
  window.__renderer = renderer;
  window.__ui = ui;
  renderer.bindInput();

  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(canvas.parentElement);
  }
  renderer.resize();

  /* ----- 主循环：逻辑与渲染分离 ----- */
  let last = performance.now();
  let hudTimer = 0;
  function frame(t) {
    const dt = Math.min(50, t - last);   // 切后台回来时限制单帧步长
    last = t;

    if ((window.devicePixelRatio || 1) !== renderer.dpr) renderer.resize();
    sim.update(dt);
    renderer.render(t);

    hudTimer += dt;
    if (hudTimer >= 250) { hudTimer = 0; ui.updateHud(); }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
