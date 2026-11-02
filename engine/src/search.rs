//! AI search (SPEC §10).
//!
//! **Algorithm.** Iterative deepening over a negamax principal-variation search (PVS) with
//! aspiration windows (from depth 5), a transposition table, a quiescence search (captures,
//! en passant and queen promotions with stand-pat, delta pruning and SEE pruning; all evasions
//! when in check), check extension, null-move pruning (not in check, side to move has non-pawn
//! material, depth >= 3, never twice in a row), reverse futility pruning, futility and
//! late-move pruning of quiet non-checking moves at shallow depth, SEE pruning of bad
//! captures at shallow depth, and late-move reductions of quiet moves (re-searched at full
//! depth on a fail-high, then with the full window at PV nodes). Mate scores are
//! `±(MATE_SCORE - ply)` with mate-distance pruning.
//!
//! **Move ordering.** TT move, queen promotions, captures that do not lose material by static
//! exchange evaluation (MVV-LVA among them), two killer moves per ply, the counter move,
//! quiet moves by history heuristic (with gravity and a malus for quiet moves that failed),
//! losing captures, under-promotions.
//!
//! **Draws inside the search.** Any earlier occurrence of the current position within the
//! halfmove-clock window — in the game history or on the search path (never across a null
//! move) — scores 0, i.e. an in-search twofold repetition is a draw. The fifty-move rule
//! (clock >= 100) and the SPEC §2.1 insufficient-material list also score 0, unless the
//! position is checkmate or stalemate (SPEC §6 precedence). Stalemate scores per variant: 0
//! for McCooey, `-STALEMATE_VALUE` (-500) for the stalemated side under Gliński's ¾ rule.
//!
//! **Limits.** `max_depth` 0 = unlimited, `time_ms` 0 = unlimited; both 0 means depth
//! [`MAX_DEPTH`] with a [`DEFAULT_TIME_MS`] time cap. The clock (`now_ms`) is polled every 1024
//! nodes; on time-out the search unwinds and returns the best move of the last completed
//! iteration, or the current iteration's best move if a root move (normally the previous best,
//! which is searched first) completed with a score above the window's lower bound. Depth 1
//! always completes. No new iteration is started after half of `time_ms` has elapsed. A legal
//! move is always returned when one exists.
//!
//! **Noise** (`noise_cp > 0`, weaker levels): every root move is searched with a full window,
//! a deterministic offset in `[-noise_cp, +noise_cp]` derived from `seed` and the move is
//! added, and the maximum is played (its un-noised score is reported).
//!
//! **Transposition table.** 16 MiB of 2-entry buckets (16-byte entries), allocated on the first
//! search (falling back to smaller sizes if the allocation fails) and kept in a `thread_local`
//! (a plain static in wasm). Depth-bounded searches (`time_ms == 0`) start from a logically
//! empty table (a new generation that ignores older entries), so they are deterministic: the
//! same game and limits always give the same move, score, PV and node count. Time-bounded
//! searches also reuse entries from earlier searches. Keys are salted with the variant.
//!
//! The search works on a clone of the game's position, so the `Game` is never touched.

use core::cell::RefCell;

use crate::clock_ms;
use crate::eval;
use crate::game::{Game, Status};
use crate::geometry::*;
use crate::movegen::{MoveList, MAX_MOVES};
use crate::position::*;
use crate::variant::StalemateRule;

/// Mate score: a mate in `n` plies scores `±(MATE_SCORE - n)`.
pub const MATE_SCORE: i32 = 30000;
/// Score of being stalemated under the ¾ rule (SPEC §10).
pub const STALEMATE_VALUE: i32 = 500;
/// Maximum PV length reported through the ABI.
pub const MAX_PV: usize = 32;
/// Maximum search ply (main search + quiescence).
pub const MAX_PLY: usize = 128;
/// Iterative-deepening depth cap.
pub const MAX_DEPTH: u32 = 64;
/// Time cap used when both `max_depth` and `time_ms` are 0.
pub const DEFAULT_TIME_MS: u32 = 5000;
/// Scores at or beyond this magnitude are mate scores.
pub const MATE_BOUND: i32 = MATE_SCORE - MAX_PLY as i32;
/// Transposition table size in bytes (power of two).
pub const TT_BYTES: usize = 16 << 20;

const INF: i32 = 32000;
const HISTORY_MAX: i32 = 16384;

/// `hc_search` arguments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchLimits {
    /// 0 = unlimited (time-bounded).
    pub max_depth: u32,
    /// 0 = unlimited (depth-bounded).
    pub time_ms: u32,
    /// > 0: weaker play, root scores get a deterministic offset in `[-noise, +noise]`.
    pub noise_cp: u32,
    pub seed: u32,
}

/// What `hc_search_info_ptr` reports.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchInfo {
    /// Depth of the last completed iteration.
    pub depth: u32,
    /// Score in centipawns from the side to move's point of view (mate = ±(30000 − plies)).
    pub score: i32,
    pub nodes: u64,
    pub elapsed_ms: u32,
    /// Principal variation (at most [`MAX_PV`] moves), starting with the best move.
    pub pv: Vec<Move>,
}

/// Result of [`search`].
#[derive(Clone, Debug, Default)]
pub struct SearchResult {
    /// Best move, or [`Move::NONE`] iff the game is over (no legal move, or a draw rule).
    pub best: Move,
    pub info: SearchInfo,
}

/// True if `score` announces a mate (for either side).
#[inline]
pub fn is_mate_score(score: i32) -> bool {
    score.abs() >= MATE_BOUND
}

// ---------------------------------------------------------------------------------------
// Transposition table

const BOUND_NONE: u8 = 0;
const BOUND_UPPER: u8 = 1;
const BOUND_LOWER: u8 = 2;
const BOUND_EXACT: u8 = 3;
const NO_EVAL: i16 = i16::MIN;

#[derive(Clone, Copy)]
#[repr(C)]
struct TtEntry {
    key: u32,
    mv: u32,
    score: i16,
    eval: i16,
    depth: i8,
    bound: u8,
    gen: u8,
    _pad: u8,
}

impl TtEntry {
    const EMPTY: TtEntry = TtEntry { key: 0, mv: 0, score: 0, eval: 0, depth: 0, bound: BOUND_NONE, gen: 0, _pad: 0 };
}

type Bucket = [TtEntry; 2];

struct TransTable {
    buckets: Vec<Bucket>,
    mask: usize,
    /// Current search generation (1..=255; 0 marks never-written entries).
    gen: u8,
    /// Only entries of the current generation are visible.
    fresh: bool,
}

impl TransTable {
    fn new() -> TransTable {
        let mut bytes = TT_BYTES;
        loop {
            let n = (bytes / core::mem::size_of::<Bucket>()).max(1);
            let mut v: Vec<Bucket> = Vec::new();
            if v.try_reserve_exact(n).is_ok() || n <= 1024 {
                v.resize(n, [TtEntry::EMPTY; 2]);
                return TransTable { buckets: v, mask: n - 1, gen: 0, fresh: true };
            }
            bytes /= 2;
        }
    }

    fn new_search(&mut self, fresh: bool) {
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            for b in self.buckets.iter_mut() {
                *b = [TtEntry::EMPTY; 2];
            }
            self.gen = 1;
        }
        self.fresh = fresh;
    }

    #[inline]
    fn live(&self, e: &TtEntry) -> bool {
        e.bound != BOUND_NONE && (e.gen == self.gen || !self.fresh)
    }

    #[inline]
    fn probe(&self, key: u64) -> Option<TtEntry> {
        let b = &self.buckets[key as usize & self.mask];
        let k = (key >> 32) as u32;
        b.iter().find(|e| e.key == k && self.live(e)).copied()
    }

    fn store(&mut self, key: u64, mv: Move, score: i32, eval: i16, depth: i32, bound: u8) {
        let idx = key as usize & self.mask;
        let k = (key >> 32) as u32;
        let (gen, fresh) = (self.gen, self.fresh);
        let live = |e: &TtEntry| e.bound != BOUND_NONE && (e.gen == gen || !fresh);
        let b = &mut self.buckets[idx];
        let slot = match b.iter().position(|e| e.key == k && live(e)) {
            Some(i) => {
                // Same position: keep a clearly deeper entry of this search unless exact.
                let e = &b[i];
                if bound != BOUND_EXACT && e.gen == gen && e.depth as i32 > depth + 2 {
                    return;
                }
                i
            }
            None => {
                let worth = |e: &TtEntry| -> i32 {
                    if !live(e) {
                        -1000
                    } else {
                        e.depth as i32 - if e.gen != gen { 64 } else { 0 }
                    }
                };
                if worth(&b[0]) <= worth(&b[1]) {
                    0
                } else {
                    1
                }
            }
        };
        let e = &mut b[slot];
        let keep_move = mv.is_none() && e.key == k && live(e);
        e.key = k;
        if !keep_move {
            e.mv = mv.0;
        }
        e.score = score as i16;
        e.eval = eval;
        e.depth = depth.clamp(0, 127) as i8;
        e.bound = bound;
        e.gen = gen;
    }
}

thread_local! {
    static TT: RefCell<Option<TransTable>> = const { RefCell::new(None) };
}

/// Variant salt for TT keys (the Zobrist hash does not include the variant).
const VARIANT_SALT: [u64; 2] = [0, 0x5BD1_E995_9E37_79B9];

#[inline]
fn score_to_tt(s: i32, ply: usize) -> i32 {
    if s >= MATE_BOUND {
        s + ply as i32
    } else if s <= -MATE_BOUND {
        s - ply as i32
    } else {
        s
    }
}

#[inline]
fn score_from_tt(s: i32, ply: usize) -> i32 {
    if s >= MATE_BOUND {
        s - ply as i32
    } else if s <= -MATE_BOUND {
        s + ply as i32
    } else {
        s
    }
}

// ---------------------------------------------------------------------------------------
// Static exchange evaluation

const SEE_VALUE: [i32; 7] = [0, 100, 300, 300, 500, 900, 20000];

/// Static exchange evaluation: true if the capture `mv` (generated for `pos`) wins at least
/// `threshold` centipawns once all recaptures on its target cell are played out, cheapest
/// attacker first (x-rays included, pins ignored). Promotions and en passant are treated as
/// non-losing.
pub fn see_ge(pos: &Position, mv: Move, threshold: i32) -> bool {
    if mv.is_promotion() || mv.is_en_passant() {
        return threshold <= 0;
    }
    let from = mv.from();
    let to = mv.to();
    let mut swap = SEE_VALUE[mv.captured()] - threshold;
    if swap < 0 {
        return false;
    }
    swap = SEE_VALUE[mv.piece()] - swap;
    if swap <= 0 {
        return true;
    }
    let mut occ = pos.occupied() ^ bit(from) ^ bit(to);
    let mut stm = pos.side_to_move();
    let mut attackers = pos.attackers_to(to, WHITE, occ) | pos.attackers_to(to, BLACK, occ);
    let diag_sliders = pos.kind_bb(BISHOP) | pos.kind_bb(QUEEN);
    let orth_sliders = pos.kind_bb(ROOK) | pos.kind_bb(QUEEN);
    let mut res = true;
    loop {
        stm ^= 1;
        attackers &= occ;
        let stm_att = attackers & pos.color_bb(stm);
        if stm_att == 0 {
            break;
        }
        res = !res;
        let mut kind = PAWN;
        while kind < KING && stm_att & pos.kind_bb(kind) == 0 {
            kind += 1;
        }
        if kind == KING {
            // The king may only recapture if the opponent has no attacker left.
            return if attackers & pos.color_bb(stm ^ 1) != 0 { !res } else { res };
        }
        swap = SEE_VALUE[kind] - swap;
        if swap < res as i32 {
            break;
        }
        occ ^= bit(lsb(stm_att & pos.kind_bb(kind)));
        // Pieces removed from a line may reveal sliders behind them (pawns capture along
        // orthogonal lines in Gliński and along diagonals in McCooey, so recompute both).
        attackers |= (bishop_attacks(to, occ) & diag_sliders) | (rook_attacks(to, occ) & orth_sliders);
    }
    res
}

// ---------------------------------------------------------------------------------------
// Searcher

struct Frame {
    moves: MoveList,
    scores: [i32; MAX_MOVES],
    killers: [Move; 2],
    /// Static evaluation at this ply (`-INF` when in check).
    eval: i32,
    /// Move made from this ply (NONE for a null move).
    mv: Move,
}

impl Frame {
    fn new() -> Frame {
        Frame { moves: MoveList::new(), scores: [0; MAX_MOVES], killers: [Move::NONE; 2], eval: 0, mv: Move::NONE }
    }
}

struct RootMove {
    mv: Move,
    /// Score of the last search of this move (exact in noise mode; `-INF` after a fail-low).
    score: i32,
    nodes: u64,
    pv: Vec<Move>,
}

struct Searcher<'t> {
    pos: Position,
    tt: &'t mut TransTable,
    salt: u64,
    frames: Vec<Frame>,
    pv: Vec<[Move; MAX_PLY]>,
    pv_len: [usize; MAX_PLY + 1],
    history: Box<[[[i32; NUM_CELLS]; 7]; 2]>,
    counter: Box<[[Move; NUM_CELLS]; 7]>,
    /// Hashes of the game history followed by the search path (current position last).
    hashes: Vec<u64>,
    /// Repetition scans never look below this index (set past a null move).
    rep_floor: usize,
    root_moves: Vec<RootMove>,
    /// Index (into `root_moves`) of the best move of the current iteration so far.
    iter_best: Option<usize>,
    root_depth: i32,
    nodes: u64,
    deadline: f64,
    check_time: bool,
    stop: bool,
    noise: u32,
    seed: u32,
    stalemate_rule: StalemateRule,
}

fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// Deterministic noise offset in `[-noise, +noise]` for a root move.
pub fn noise_offset(seed: u32, mv: Move, noise: u32) -> i32 {
    if noise == 0 {
        return 0;
    }
    let r = mix(((seed as u64) << 32) | mv.key() as u64);
    (r % (2 * noise as u64 + 1)) as i32 - noise as i32
}

/// `2 * atanh(z)` by its power series (|z| <= 1/3 here, so 40 terms are plenty).
const fn two_atanh(z: f64) -> f64 {
    let z2 = z * z;
    let mut term = z;
    let mut sum = 0.0;
    let mut n = 1.0;
    let mut i = 0;
    while i < 40 {
        sum += term / n;
        term *= z2;
        n += 2.0;
        i += 1;
    }
    2.0 * sum
}

/// Natural logarithm for `x >= 1`, evaluated at compile time (so the reduction table is
/// identical on every platform, independent of the target's libm).
const fn ln_const(x: f64) -> f64 {
    let mut y = x;
    let mut k = 0;
    while y >= 2.0 {
        y /= 2.0;
        k += 1;
    }
    k as f64 * two_atanh(1.0 / 3.0) + two_atanh((y - 1.0) / (y + 1.0))
}

const fn build_lmr() -> [[u8; 64]; 64] {
    let mut t = [[0u8; 64]; 64];
    let mut d = 1;
    while d < 64 {
        let mut m = 1;
        while m < 64 {
            t[d][m] = (0.75 + ln_const(d as f64) * ln_const(m as f64) / 2.25) as u8;
            m += 1;
        }
        d += 1;
    }
    t
}

/// Late-move reduction by `[depth][moves searched]`: `0.75 + ln(depth) * ln(moves) / 2.25`.
static LMR: [[u8; 64]; 64] = build_lmr();

#[inline]
fn history_update(h: &mut i32, bonus: i32) {
    *h += bonus - *h * bonus.abs() / HISTORY_MAX;
}

/// MVV-LVA key: most valuable victim first, then least valuable attacker.
#[inline]
fn mvv_lva(mv: Move) -> i32 {
    SEE_VALUE[mv.captured()] * 8 - mv.piece() as i32
}

impl<'t> Searcher<'t> {
    fn new(game: &Game, tt: &'t mut TransTable, limits: &SearchLimits, deadline: f64) -> Searcher<'t> {
        let pos = game.position().clone();
        let salt = VARIANT_SALT[pos.variant() as usize & 1];
        let stalemate_rule = pos.variant().stalemate_rule();
        let mut hashes = Vec::with_capacity(game.hash_history().len() + MAX_PLY + 2);
        hashes.extend_from_slice(game.hash_history());
        Searcher {
            pos,
            tt,
            salt,
            frames: (0..=MAX_PLY).map(|_| Frame::new()).collect(),
            pv: vec![[Move::NONE; MAX_PLY]; MAX_PLY],
            pv_len: [0; MAX_PLY + 1],
            history: Box::new([[[0; NUM_CELLS]; 7]; 2]),
            counter: Box::new([[Move::NONE; NUM_CELLS]; 7]),
            hashes,
            rep_floor: 0,
            root_moves: Vec::new(),
            iter_best: None,
            root_depth: 1,
            nodes: 0,
            deadline,
            check_time: false,
            stop: false,
            noise: limits.noise_cp,
            seed: limits.seed,
            stalemate_rule,
        }
    }

    #[inline]
    fn tick(&mut self) {
        self.nodes += 1;
        if self.check_time && self.nodes & 1023 == 0 && clock_ms() >= self.deadline {
            self.stop = true;
        }
    }

    #[inline]
    fn tt_key(&self) -> u64 {
        self.pos.hash() ^ self.salt
    }

    /// Score of the side to move when it is stalemated.
    #[inline]
    fn stalemated(&self, ply: usize) -> i32 {
        match self.stalemate_rule {
            StalemateRule::Draw => 0,
            StalemateRule::ThreeQuarters => -STALEMATE_VALUE,
            StalemateRule::Win => -(MATE_SCORE - ply as i32),
        }
    }

    /// 0 for a draw by rule, unless the position is actually checkmate or stalemate.
    fn draw_unless_terminal(&self, ply: usize, in_check: bool) -> i32 {
        if self.pos.has_legal_move() {
            0
        } else if in_check {
            -(MATE_SCORE - ply as i32)
        } else {
            self.stalemated(ply)
        }
    }

    /// True if the current position occurred before within the halfmove-clock window (same
    /// side to move), in the game history or on the search path.
    #[inline]
    fn is_repetition(&self) -> bool {
        let n = self.hashes.len() - 1;
        let cur = self.hashes[n];
        let lo = n.saturating_sub(self.pos.halfmove_clock() as usize).max(self.rep_floor);
        let mut i = n;
        while i >= lo + 2 {
            i -= 2;
            if self.hashes[i] == cur {
                return true;
            }
        }
        false
    }

    #[inline]
    fn update_pv(&mut self, ply: usize, mv: Move) {
        let child_len = self.pv_len[ply + 1].max(ply + 1);
        self.pv[ply][ply] = mv;
        for i in ply + 1..child_len {
            self.pv[ply][i] = self.pv[ply + 1][i];
        }
        self.pv_len[ply] = child_len;
    }

    /// Scores the moves of `frames[ply]` for ordering.
    fn score_moves(&mut self, ply: usize, tt_move: Move) {
        let us = self.pos.side_to_move();
        let killers = self.frames[ply].killers;
        let counter = if ply > 0 {
            let pm = self.frames[ply - 1].mv;
            if pm.is_none() {
                Move::NONE
            } else {
                self.counter[pm.piece()][pm.to()]
            }
        } else {
            Move::NONE
        };
        let pos = &self.pos;
        let history = &self.history[us];
        let f = &mut self.frames[ply];
        for i in 0..f.moves.len() {
            let m = f.moves[i];
            f.scores[i] = if m == tt_move {
                1 << 30
            } else if m.is_promotion() {
                if m.promo() == QUEEN {
                    (1 << 29) + mvv_lva(m)
                } else {
                    -(1 << 29) + m.promo() as i32
                }
            } else if m.is_capture() {
                if see_ge(pos, m, 0) {
                    (1 << 28) + mvv_lva(m)
                } else {
                    -(1 << 28) + mvv_lva(m)
                }
            } else if m == killers[0] {
                (1 << 27) + 2
            } else if m == killers[1] {
                (1 << 27) + 1
            } else if m == counter {
                1 << 27
            } else {
                history[m.piece()][m.to()]
            };
        }
    }

    /// Selection step: moves the best-scored remaining move to index `i` and returns it.
    #[inline]
    fn pick(&mut self, ply: usize, i: usize) -> Move {
        let f = &mut self.frames[ply];
        let n = f.moves.len();
        let mut best = i;
        for j in i + 1..n {
            if f.scores[j] > f.scores[best] {
                best = j;
            }
        }
        if best != i {
            f.moves.as_mut_slice().swap(i, best);
            f.scores.swap(i, best);
        }
        f.moves[i]
    }

    fn update_quiet_stats(&mut self, ply: usize, mv: Move, depth: i32, tried: &[Move]) {
        let us = self.pos.side_to_move();
        let bonus = (depth * depth).min(400);
        history_update(&mut self.history[us][mv.piece()][mv.to()], bonus);
        for &q in tried {
            if q != mv {
                history_update(&mut self.history[us][q.piece()][q.to()], -bonus);
            }
        }
        let f = &mut self.frames[ply];
        if f.killers[0] != mv {
            f.killers[1] = f.killers[0];
            f.killers[0] = mv;
        }
        if ply > 0 {
            let pm = self.frames[ply - 1].mv;
            if !pm.is_none() {
                self.counter[pm.piece()][pm.to()] = mv;
            }
        }
    }

    // -- quiescence -----------------------------------------------------------------------

    fn qsearch(&mut self, ply: usize, mut alpha: i32, beta: i32) -> i32 {
        self.tick();
        if self.stop {
            return 0;
        }
        let in_check = self.pos.in_check();
        if ply >= MAX_PLY - 1 {
            return if in_check { 0 } else { eval::evaluate_stm(&self.pos) };
        }

        if in_check {
            // All evasions; no stand-pat.
            self.pos.gen_legal(&mut self.frames[ply].moves);
            let n = self.frames[ply].moves.len();
            if n == 0 {
                return -(MATE_SCORE - ply as i32);
            }
            self.score_moves(ply, Move::NONE);
            let mut best = -INF;
            for i in 0..n {
                let mv = self.pick(ply, i);
                self.frames[ply].mv = mv;
                let u = self.pos.make(mv);
                let score = -self.qsearch(ply + 1, -beta, -alpha);
                self.pos.unmake(mv, &u);
                if self.stop {
                    return 0;
                }
                if score > best {
                    best = score;
                    if score > alpha {
                        if score >= beta {
                            return score;
                        }
                        alpha = score;
                    }
                }
            }
            return best;
        }

        if self.pos.is_insufficient_material() {
            return 0;
        }
        let stand = eval::evaluate_stm(&self.pos);
        if stand >= beta {
            return stand;
        }
        if stand > alpha {
            alpha = stand;
        }
        self.pos.gen_legal_noisy(&mut self.frames[ply].moves);
        let n = self.frames[ply].moves.len();
        {
            let f = &mut self.frames[ply];
            for i in 0..n {
                let m = f.moves[i];
                f.scores[i] = match m.promo() {
                    0 => mvv_lva(m),
                    QUEEN => (1 << 20) + mvv_lva(m),
                    _ => i32::MIN, // under-promotions are not searched here
                };
            }
        }
        let mut best = stand;
        for i in 0..n {
            let mv = self.pick(ply, i);
            if self.frames[ply].scores[i] == i32::MIN {
                break;
            }
            if !mv.is_promotion() {
                // Delta pruning: even winning the victim for free cannot reach alpha.
                if stand + eval::PIECE_VALUE[mv.captured()] + 200 <= alpha {
                    continue;
                }
                if !see_ge(&self.pos, mv, 0) {
                    continue;
                }
            }
            self.frames[ply].mv = mv;
            let u = self.pos.make(mv);
            let score = -self.qsearch(ply + 1, -beta, -alpha);
            self.pos.unmake(mv, &u);
            if self.stop {
                return 0;
            }
            if score > best {
                best = score;
                if score > alpha {
                    if score >= beta {
                        return score;
                    }
                    alpha = score;
                }
            }
        }
        best
    }

    // -- main search ----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn negamax(&mut self, mut depth: i32, ply: usize, mut alpha: i32, mut beta: i32, pv_node: bool, null_ok: bool) -> i32 {
        if pv_node {
            self.pv_len[ply] = ply;
        }
        self.tick();
        if self.stop {
            return 0;
        }
        let in_check = self.pos.in_check();
        if ply > 0 {
            if self.is_repetition() {
                return 0;
            }
            if self.pos.halfmove_clock() >= 100 || self.pos.is_insufficient_material() {
                return self.draw_unless_terminal(ply, in_check);
            }
            // Mate-distance pruning.
            alpha = alpha.max(-(MATE_SCORE - ply as i32));
            beta = beta.min(MATE_SCORE - ply as i32 - 1);
            if alpha >= beta {
                return alpha;
            }
        }
        if ply >= MAX_PLY - 2 {
            return if in_check { 0 } else { eval::evaluate_stm(&self.pos) };
        }
        // Check extension (bounded so that checking sequences cannot run away).
        if in_check && (ply as i32) < 2 * self.root_depth + 8 {
            depth += 1;
        }
        if depth <= 0 {
            return self.qsearch(ply, alpha, beta);
        }

        let key = self.tt_key();
        let mut tt_move = Move::NONE;
        let mut tt_eval = None;
        if let Some(e) = self.tt.probe(key) {
            tt_move = Move(e.mv);
            if !pv_node && e.depth as i32 >= depth {
                let s = score_from_tt(e.score as i32, ply);
                let cut = match e.bound {
                    BOUND_EXACT => true,
                    BOUND_LOWER => s >= beta,
                    BOUND_UPPER => s <= alpha,
                    _ => false,
                };
                if cut {
                    return s;
                }
            }
            if e.eval != NO_EVAL {
                tt_eval = Some(e.eval as i32);
            }
        }

        let us = self.pos.side_to_move();
        let static_eval = if in_check { -INF } else { tt_eval.unwrap_or_else(|| eval::evaluate_stm(&self.pos)) };
        self.frames[ply].eval = static_eval;
        let improving = !in_check && ply >= 2 && static_eval > self.frames[ply - 2].eval;

        if !pv_node && !in_check && !is_mate_score(beta) {
            // Reverse futility pruning.
            if depth <= 6 && static_eval - 90 * (depth - improving as i32) >= beta {
                return static_eval;
            }
            // Null-move pruning.
            if null_ok && depth >= 3 && static_eval >= beta && self.pos.has_non_pawn_material(us) {
                let r = 3 + depth / 4 + ((static_eval - beta) / 200).min(2);
                let u = self.pos.make_null();
                self.frames[ply].mv = Move::NONE;
                self.hashes.push(self.pos.hash());
                let saved_floor = self.rep_floor;
                self.rep_floor = self.hashes.len() - 1;
                let score = -self.negamax(depth - 1 - r, ply + 1, -beta, -beta + 1, false, false);
                self.rep_floor = saved_floor;
                self.hashes.pop();
                self.pos.unmake_null(&u);
                if self.stop {
                    return 0;
                }
                if score >= beta {
                    return if is_mate_score(score) { beta } else { score };
                }
            }
        }

        // Internal iterative reduction: no TT move here means poor ordering anyway.
        if tt_move.is_none() && depth >= 4 {
            depth -= 1;
        }

        self.pos.gen_legal(&mut self.frames[ply].moves);
        let n = self.frames[ply].moves.len();
        if n == 0 {
            return if in_check { -(MATE_SCORE - ply as i32) } else { self.stalemated(ply) };
        }
        self.score_moves(ply, tt_move);
        let killers = self.frames[ply].killers;

        let orig_alpha = alpha;
        let mut best_score = -INF;
        let mut best_move = Move::NONE;
        let mut searched = 0usize;
        let mut quiets_searched = 0i32;
        let mut tried = [Move::NONE; 64];
        let mut n_tried = 0usize;
        let lmp_limit = (3 + depth * depth) / if improving { 1 } else { 2 };

        for i in 0..n {
            let mv = self.pick(ply, i);
            let quiet = !mv.is_noisy();
            let may_prune = !pv_node && !in_check && searched > 0 && best_score > -MATE_BOUND;
            if may_prune && !quiet && depth <= 4 && !see_ge(&self.pos, mv, -100 * depth) {
                continue;
            }
            let u = self.pos.make(mv);
            let gives_check = self.pos.in_check();
            if may_prune
                && quiet
                && !gives_check
                && ((depth <= 5 && quiets_searched >= lmp_limit)
                    || (depth <= 4 && static_eval + 100 + 100 * depth <= alpha))
            {
                self.pos.unmake(mv, &u);
                continue;
            }
            self.frames[ply].mv = mv;
            self.hashes.push(self.pos.hash());
            if pv_node {
                self.pv_len[ply + 1] = ply + 1;
            }
            let new_depth = depth - 1;
            let lmr_from = if pv_node { 3 } else { 2 };
            let mut score;
            if searched == 0 {
                score = -self.negamax(new_depth, ply + 1, -beta, -alpha, pv_node, true);
            } else {
                let mut r = 0;
                if depth >= 3 && quiet && !in_check && !gives_check && searched >= lmr_from {
                    r = LMR[(depth as usize).min(63)][searched.min(63)] as i32;
                    if pv_node {
                        r -= 1;
                    }
                    if mv == killers[0] || mv == killers[1] {
                        r -= 1;
                    }
                    if !improving {
                        r += 1;
                    }
                    r -= self.history[us][mv.piece()][mv.to()] / 6000;
                    r = r.clamp(0, new_depth - 1);
                }
                score = -self.negamax(new_depth - r, ply + 1, -alpha - 1, -alpha, false, true);
                if score > alpha && r > 0 && !self.stop {
                    score = -self.negamax(new_depth, ply + 1, -alpha - 1, -alpha, false, true);
                }
                if pv_node && score > alpha && score < beta && !self.stop {
                    self.pv_len[ply + 1] = ply + 1;
                    score = -self.negamax(new_depth, ply + 1, -beta, -alpha, true, true);
                }
            }
            self.hashes.pop();
            self.pos.unmake(mv, &u);
            if self.stop {
                return 0;
            }
            searched += 1;
            if quiet {
                quiets_searched += 1;
            }
            if score > best_score {
                best_score = score;
                if score > alpha {
                    best_move = mv;
                    if pv_node {
                        self.update_pv(ply, mv);
                    }
                    if score >= beta {
                        if quiet {
                            self.update_quiet_stats(ply, mv, depth, &tried[..n_tried]);
                        }
                        break;
                    }
                    alpha = score;
                }
            }
            if quiet && n_tried < tried.len() {
                tried[n_tried] = mv;
                n_tried += 1;
            }
        }

        let bound = if best_score >= beta {
            BOUND_LOWER
        } else if best_score > orig_alpha {
            BOUND_EXACT
        } else {
            BOUND_UPPER
        };
        let stored_eval = if in_check { NO_EVAL } else { static_eval as i16 };
        self.tt.store(key, best_move, score_to_tt(best_score, ply), stored_eval, depth, bound);
        best_score
    }

    // -- root -----------------------------------------------------------------------------

    fn search_root(&mut self, depth: i32, mut alpha: i32, beta: i32) -> i32 {
        let mut best = -INF;
        for i in 0..self.root_moves.len() {
            let mv = self.root_moves[i].mv;
            let nodes_before = self.nodes;
            let u = self.pos.make(mv);
            self.frames[0].mv = mv;
            self.hashes.push(self.pos.hash());
            self.pv_len[1] = 1;
            let score = if self.noise > 0 {
                -self.negamax(depth - 1, 1, -INF, INF, true, true)
            } else if i == 0 {
                -self.negamax(depth - 1, 1, -beta, -alpha, true, true)
            } else {
                let mut s = -self.negamax(depth - 1, 1, -alpha - 1, -alpha, false, true);
                if s > alpha && s < beta && !self.stop {
                    self.pv_len[1] = 1;
                    s = -self.negamax(depth - 1, 1, -beta, -alpha, true, true);
                }
                s
            };
            self.hashes.pop();
            self.pos.unmake(mv, &u);
            if self.stop {
                break;
            }
            let child_pv_end = self.pv_len[1].clamp(1, MAX_PLY);
            let rm = &mut self.root_moves[i];
            rm.nodes += self.nodes - nodes_before;
            if self.noise > 0 || score > alpha {
                rm.score = score;
                rm.pv.clear();
                rm.pv.push(mv);
                let take = child_pv_end.min(MAX_PV);
                rm.pv.extend_from_slice(&self.pv[1][1..take]);
            } else {
                rm.score = -INF;
            }
            if score > best {
                best = score;
                if score > alpha && self.noise == 0 {
                    self.iter_best = Some(i);
                    if score >= beta {
                        break;
                    }
                    alpha = score;
                }
            }
        }
        best
    }

    fn aspiration(&mut self, depth: i32, prev: i32) -> i32 {
        let mut delta = 25;
        let mut alpha = (prev - delta).max(-INF);
        let mut beta = (prev + delta).min(INF);
        loop {
            let score = self.search_root(depth, alpha, beta);
            if self.stop {
                return score;
            }
            if score <= alpha {
                beta = (alpha + beta) / 2;
                alpha = (score - delta).max(-INF);
            } else if score >= beta {
                // Search the move that failed high first in the re-search.
                if let Some(i) = self.iter_best {
                    self.root_moves[..=i].rotate_right(1);
                    self.iter_best = Some(0);
                }
                beta = (score + delta).min(INF);
            } else {
                return score;
            }
            delta += delta;
            if delta > 1000 {
                alpha = -INF;
                beta = INF;
            }
        }
    }

    fn run(&mut self, root: &MoveList, max_depth: u32, start: f64, time_ms: u32) -> SearchResult {
        // Initial root ordering (TT move / captures by SEE and MVV-LVA / ...).
        let tt_move = self.tt.probe(self.tt_key()).map_or(Move::NONE, |e| Move(e.mv));
        self.pos.gen_legal(&mut self.frames[0].moves);
        self.score_moves(0, tt_move);
        let n = self.frames[0].moves.len();
        debug_assert_eq!(n, root.len());
        let mut order: Vec<(i32, Move)> = (0..n).map(|i| (self.frames[0].scores[i], self.frames[0].moves[i])).collect();
        order.sort_by_key(|a| core::cmp::Reverse(a.0));
        self.root_moves = order.into_iter().map(|(_, mv)| RootMove { mv, score: -INF, nodes: 0, pv: Vec::new() }).collect();

        let mut best = self.root_moves[0].mv;
        let mut best_score = 0;
        let mut best_pv = vec![best];
        let mut completed = 0u32;
        let mut prev_score = 0;
        let single = self.root_moves.len() == 1;

        for depth in 1..=max_depth {
            self.root_depth = depth as i32;
            self.check_time = time_ms > 0 && depth > 1;
            self.iter_best = None;
            for rm in self.root_moves.iter_mut() {
                rm.nodes = 0;
            }
            let score = if self.noise > 0 || depth < 5 || is_mate_score(prev_score) {
                self.search_root(depth as i32, -INF, INF)
            } else {
                self.aspiration(depth as i32, prev_score)
            };
            if self.stop {
                if self.noise == 0 {
                    if let Some(i) = self.iter_best {
                        let rm = &self.root_moves[i];
                        best = rm.mv;
                        best_score = rm.score;
                        best_pv = rm.pv.clone();
                    }
                }
                break;
            }
            completed = depth;
            let bi = if self.noise > 0 {
                let mut bi = 0;
                let mut bv = i32::MIN;
                for (i, rm) in self.root_moves.iter().enumerate() {
                    let v = rm.score + noise_offset(self.seed, rm.mv, self.noise);
                    if v > bv {
                        bv = v;
                        bi = i;
                    }
                }
                bi
            } else {
                self.iter_best.unwrap_or(0)
            };
            best = self.root_moves[bi].mv;
            best_score = if self.noise > 0 { self.root_moves[bi].score } else { score };
            best_pv = self.root_moves[bi].pv.clone();
            if best_pv.first() != Some(&best) {
                best_pv = vec![best];
            }
            prev_score = score;

            // Next iteration: best move first, then by effort (noise: by exact score).
            let first = self.root_moves.remove(bi);
            if self.noise > 0 {
                self.root_moves.sort_by_key(|a| core::cmp::Reverse(a.score));
            } else {
                self.root_moves.sort_by_key(|a| core::cmp::Reverse(a.nodes));
            }
            self.root_moves.insert(0, first);

            if is_mate_score(best_score) && depth as i32 >= MATE_SCORE - best_score.abs() {
                break;
            }
            if time_ms > 0 {
                if single && depth >= 4 {
                    break;
                }
                if clock_ms() - start >= time_ms as f64 * 0.5 {
                    break;
                }
            }
        }

        best_pv.truncate(MAX_PV);
        let elapsed = (clock_ms() - start).max(0.0);
        SearchResult {
            best,
            info: SearchInfo {
                depth: completed,
                score: best_score,
                nodes: self.nodes,
                elapsed_ms: elapsed.min(u32::MAX as f64) as u32,
                pv: best_pv,
            },
        }
    }
}

/// Searches the game's current position (SPEC §7 `hc_search`, §10). Never mutates `game`.
/// Returns [`Move::NONE`] (with a zeroed info) iff the game is over — checkmate, stalemate or
/// a draw by rule; otherwise always a legal move, even if time runs out during depth 1.
pub fn search(game: &Game, limits: &SearchLimits) -> SearchResult {
    let start = clock_ms();
    if game.status() != Status::Ongoing {
        return SearchResult::default();
    }
    let root = game.legal_moves();
    if root.is_empty() {
        return SearchResult::default();
    }
    let (max_depth, time_ms) = match (limits.max_depth, limits.time_ms) {
        (0, 0) => (MAX_DEPTH, DEFAULT_TIME_MS),
        (0, t) => (MAX_DEPTH, t),
        (d, t) => (d.min(MAX_DEPTH), t),
    };
    let deadline = if time_ms == 0 { f64::INFINITY } else { start + time_ms as f64 };
    TT.with(|cell| {
        let mut slot = cell.borrow_mut();
        let tt = slot.get_or_insert_with(TransTable::new);
        tt.new_search(time_ms == 0);
        let mut s = Searcher::new(game, tt, limits, deadline);
        s.run(&root, max_depth, start, time_ms)
    })
}

/// Static evaluation of the game's position from the side to move's point of view, as the
/// search sees it (including the tempo bonus).
pub fn static_eval_stm(game: &Game) -> i32 {
    eval::evaluate_stm(game.position())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn const_log_and_reduction_table() {
        for x in 1..200 {
            let x = x as f64;
            assert!((ln_const(x) - x.ln()).abs() < 1e-12, "{x}");
        }
        for d in 1..64 {
            for m in 1..64 {
                let r = (0.75 + (d as f64).ln() * (m as f64).ln() / 2.25) as u8;
                assert_eq!(LMR[d][m], r, "{d} {m}");
            }
        }
        assert_eq!((LMR[3][3], LMR[10][20], LMR[63][63]), (1, 3, 8));
    }
}
