//! # hexchess_engine
//!
//! Rules engine and AI for hexagonal chess (Gliński's and McCooey's variants), compiled to
//! WebAssembly (`wasm32-unknown-unknown`, zero dependencies). `docs/SPEC.md` is the
//! contract; this crate implements SPEC §1–§7 and §10.
//!
//! Modules: [`geometry`] (cells, directions, precomputed tables), [`variant`] (setups,
//! pawn rules), [`position`] (board, make/unmake, Zobrist, FEN), [`movegen`] (attacks,
//! legal/pseudo-legal generation, perft), [`notation`] (SAN, move parsing), [`game`]
//! (history, undo, repetition, status), [`eval`], [`search`]. This file holds the thin
//! C-ABI layer (`hc_*` exports, SPEC §7).
//!
//! ## Internal API for search/eval
//!
//! Everything below is allocation-free unless noted; all tables are `static`s computed at
//! compile time (no runtime init).
//!
//! **Cells & bitboards** ([`geometry`]): a cell is a `usize` 0..=90 (SPEC §1 canonical
//! index); a [`Bitboard`] is a `u128` (bit i = cell i). Helpers: [`bit`], [`lsb`],
//! [`msb`], [`pop_lsb`], [`cells`] (iterator). Tables: `NEIGHBOR[dir][cell]` (`NO_CELL` =
//! 255 off-board), `RAYS[dir][cell]`, `KNIGHT_ATTACKS[cell]`, `KING_ATTACKS[cell]`,
//! `ORTHO_LINES` / `DIAG_LINES[cell]` (all rook / bishop rays), `DIR_BETWEEN[a][b]`,
//! `CENTER_DIST[cell]` (hex distance to f6, 0..=5), `CELL_COLOR[cell]` (colour class
//! 0..=2), `CELL_FILE`, `CELL_RANK`, `CELL_Q`, `CELL_R`; functions `rook_attacks(cell, occ)`,
//! `bishop_attacks`, `queen_attacks`, `ray_attacks(dir, cell, occ)`, `between(a, b)`,
//! `line_through(a, b)`, `hex_distance(a, b)`. Directions: `DIR_N, DIR_NE, DIR_SE, DIR_S,
//! DIR_SW, DIR_NW` (0..6, orthogonal) and `DIR_NNE, DIR_E, DIR_SSE, DIR_SSW, DIR_W, DIR_NNW`
//! (6..12, diagonal).
//!
//! **Variant parameters** ([`variant`]): [`Variant`] (`Glinski` = 0, `McCooey` = 1),
//! `variant.def()` → [`VariantDef`] (`name`, `start_fen`, `stalemate_rule`
//! ([`StalemateRule`]: `Draw` / `ThreeQuarters` / `Win`), `pawn_capture_dirs[color]`,
//! `double_step[color]`). Pawn tables: `PAWN_ATTACKS[variant][color][cell]` (capture
//! targets; the pawns of colour `c` attacking `x` are `PAWN_ATTACKS[v][c ^ 1][x] &
//! pawns(c)`), `PAWN_PUSH[color][cell]`, `PROMOTION_CELLS[color]`,
//! `PROMO_DISTANCE[color][cell]` (pushes left to promote).
//!
//! **Pieces & moves** ([`position`]): colours `WHITE = 0`, `BLACK = 1`; kinds `PAWN = 1 …
//! KING = 6` (`usize`). [`Move`] is the SPEC §4 `u32` code (`from()`, `to()`, `promo()`,
//! `piece()`, `captured()`, `is_capture()`, `is_en_passant()`, `is_double_step()`,
//! `is_promotion()`, `is_noisy()`, `key()`; `Move::NONE` = 0). The moving and captured piece
//! kinds are always filled in by the generator, so MVV-LVA needs no board lookup.
//!
//! **Position** ([`Position`], `Clone` ≈ 300-byte memcpy):
//! * state: `side_to_move()`, `piece_at(cell)` (signed code), `kind_at(cell)`, `board()`,
//!   `pieces(color, kind)`, `color_bb(color)`, `kind_bb(kind)`, `occupied()`,
//!   `king_cell(color)`, `ep_capture_cell()` (ep target only if a capture is available),
//!   `halfmove_clock()`, `fullmove_number()`, `variant()`, `has_non_pawn_material(color)`,
//!   `is_insufficient_material()`.
//! * hashing: `hash()` is the incrementally updated Zobrist key (pieces, side to move, ep
//!   cell only when an ep capture is available); `compute_hash()` recomputes it from scratch.
//! * make/unmake: `let u = pos.make(mv); … pos.unmake(mv, &u);` ([`Undo`] is 16 bytes;
//!   `mv` must have been generated for this position). Null move: `make_null()` /
//!   `unmake_null(&u)` (not when in check).
//! * generation into a stack [`MoveList`] (capacity 512, derefs to `[Move]`, cleared
//!   first): `gen_legal(&mut list)`, `gen_legal_noisy` (captures, en passant and all
//!   promotions incl. quiet ones — filter under-promotions yourself if wanted),
//!   `gen_pseudo`, `gen_pseudo_noisy` (+ `is_legal(&mut self, mv)` to filter),
//!   `legal_moves()` (returns a list), `has_legal_move()`.
//! * attacks: `in_check()`, `checkers()`, `is_attacked(cell, by_color)`,
//!   `is_attacked_occ(cell, by, occ)`, `attackers_to(cell, by, occ)` (for SEE),
//!   `pinned_pieces(king_cell, color, occ)`, `gives_check(&mut self, mv)`.
//! * `perft(depth)` (bulk-counted), `perft_full`, `perft_divide`.
//!
//! **Game** ([`Game`]): `position()`, `variant()`, `hash_history()` (hash of every position
//! since the game's start position, current one last — use with `halfmove_clock()` for
//! repetition detection), `status()` ([`Status`]), `legal_moves()`, `make_move`, `undo`.
//!
//! **Search hooks**: `hc_eval` calls [`eval::evaluate`]`(&Position) -> i32` (White POV);
//! `hc_search` calls [`search::search`]`(&Game, &SearchLimits) -> SearchResult` and copies
//! `SearchResult.info` into the info buffer; it calls `search` only when `status()` is
//! `Ongoing` (and `search` itself returns `Move::NONE` for a finished game). The algorithms
//! and their limits are documented in the [`search`] and [`eval`] module docs; the
//! transposition table (16 MiB) is allocated on the first search and kept in a thread-local.
//! [`clock_ms`] is the millisecond clock (the `env.now_ms` import in wasm).
//! Move ordering can sort `list.as_mut_slice()` in place (or keep a parallel score array);
//! `MoveList::find_key(key)` locates a TT/killer move among generated moves. Keep any state
//! that persists between searches (e.g. a transposition table) in a `thread_local!` (a plain
//! static in wasm) so the parallel native test threads never share it.
//!
//! ## ABI notes (SPEC §7)
//! * Handles are `Box<Game>` raw pointers; every `hc_*` taking a handle tolerates null
//!   (returns 0, or -1 for the cell queries).
//! * One shared string buffer of [`STR_BUF_LEN`] bytes (`hc_str_ptr`); the info buffer has
//!   `6 + 32` `i32`s (`hc_search_info_ptr`). Both are thread-local natively (so parallel
//!   `cargo test` threads do not race) and plain statics in wasm.
//! * Extra export (not in SPEC §7): `hc_last_error() -> u32` writes the reason of the last
//!   failed `hc_load_fen` (or "" after a success) to the string buffer and returns its length.

#![allow(clippy::not_unsafe_ptr_arg_deref, clippy::new_without_default, clippy::needless_range_loop)]

pub mod eval;
pub mod game;
pub mod geometry;
pub mod movegen;
pub mod notation;
pub mod position;
pub mod search;
pub mod variant;

pub use game::{Game, HistoryEntry, Status};
pub use geometry::{bit, cells, lsb, msb, pop_lsb, Bitboard, NO_CELL, NUM_CELLS};
pub use movegen::{MoveList, MAX_MOVES};
pub use position::{
    FenError, Move, Position, Undo, BISHOP, BLACK, KING, KNIGHT, PAWN, QUEEN, ROOK, WHITE,
};
pub use variant::{StalemateRule, Variant, VariantDef};

use core::cell::{RefCell, UnsafeCell};

// ---------------------------------------------------------------------------------------
// Clock: the ONLY wasm import (SPEC §0).

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn now_ms() -> f64; // JS supplies env.now_ms = () => performance.now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms_native() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Monotonic milliseconds from an arbitrary epoch (`performance.now()` in wasm).
#[inline]
pub fn clock_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        // SAFETY: plain import without arguments.
        unsafe { now_ms() }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        now_ms_native()
    }
}

// ---------------------------------------------------------------------------------------
// Shared output buffers

/// Size of the shared string output buffer.
pub const STR_BUF_LEN: usize = 16 * 1024;
/// Size (in `i32`s) of the search-info buffer: 6 header fields + 32 PV moves.
pub const INFO_LEN: usize = 6 + search::MAX_PV;

thread_local! {
    static STR_BUF: UnsafeCell<[u8; STR_BUF_LEN]> = const { UnsafeCell::new([0; STR_BUF_LEN]) };
    static INFO_BUF: UnsafeCell<[i32; INFO_LEN]> = const { UnsafeCell::new([0; INFO_LEN]) };
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Copies `s` into the string buffer (truncated at a char boundary) and returns its length.
fn put_str(s: &str) -> u32 {
    STR_BUF.with(|cell| {
        let mut n = s.len().min(STR_BUF_LEN);
        while !s.is_char_boundary(n) {
            n -= 1;
        }
        // SAFETY: single-threaded access to this thread's buffer; no outstanding borrows.
        let buf = unsafe { &mut *cell.get() };
        buf[..n].copy_from_slice(&s.as_bytes()[..n]);
        n as u32
    })
}

fn write_info(info: &search::SearchInfo) {
    INFO_BUF.with(|cell| {
        // SAFETY: as in `put_str`.
        let buf = unsafe { &mut *cell.get() };
        buf.fill(0);
        let pv_len = info.pv.len().min(search::MAX_PV);
        buf[0] = info.depth as i32;
        buf[1] = info.score;
        buf[2] = info.nodes as u32 as i32;
        buf[3] = (info.nodes >> 32) as u32 as i32;
        buf[4] = info.elapsed_ms as i32;
        buf[5] = pv_len as i32;
        for (i, m) in info.pv.iter().take(pv_len).enumerate() {
            buf[6 + i] = m.0 as i32;
        }
    })
}

#[inline]
fn game_ref<'a>(g: *mut Game) -> Option<&'a mut Game> {
    // SAFETY: the handle is null or a pointer from `hc_new` that has not been destroyed.
    unsafe { g.as_mut() }
}

/// Borrows `len` bytes at `ptr` (JS-provided). `None` for a null pointer with `len > 0`.
fn input_bytes<'a>(ptr: *const u8, len: u32) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    if ptr.is_null() {
        return None;
    }
    // SAFETY: JS guarantees `ptr..ptr+len` lies in linear memory (from `hc_alloc`).
    Some(unsafe { core::slice::from_raw_parts(ptr, len as usize) })
}

fn input_str<'a>(ptr: *const u8, len: u32) -> Option<&'a str> {
    core::str::from_utf8(input_bytes(ptr, len)?).ok()
}

// ---------------------------------------------------------------------------------------
// ABI (SPEC §7)

#[no_mangle]
pub extern "C" fn hc_abi_version() -> u32 {
    1
}

/// Allocates `len` bytes (at least 1) for JS→wasm strings; free with `hc_free(ptr, len)`.
#[no_mangle]
pub extern "C" fn hc_alloc(len: u32) -> *mut u8 {
    let size = (len as usize).max(1);
    match std::alloc::Layout::from_size_align(size, 1) {
        // SAFETY: non-zero size.
        Ok(layout) => unsafe { std::alloc::alloc(layout) },
        Err(_) => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn hc_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    let size = (len as usize).max(1);
    if let Ok(layout) = std::alloc::Layout::from_size_align(size, 1) {
        // SAFETY: `ptr` came from `hc_alloc(len)` with the same layout.
        unsafe { std::alloc::dealloc(ptr, layout) }
    }
}

#[no_mangle]
pub extern "C" fn hc_str_ptr() -> *const u8 {
    STR_BUF.with(|cell| cell.get() as *const u8)
}

#[no_mangle]
pub extern "C" fn hc_last_error() -> u32 {
    LAST_ERROR.with(|e| put_str(&e.borrow()))
}

#[no_mangle]
pub extern "C" fn hc_variant_count() -> u32 {
    variant::VARIANT_COUNT as u32
}

#[no_mangle]
pub extern "C" fn hc_variant_name(v: u32) -> u32 {
    match Variant::from_index(v) {
        Some(var) => put_str(var.name()),
        None => 0,
    }
}

/// 0 = draw, 1 = stalemating side scores ¾, 2 = stalemating side wins (0 for a bad variant).
#[no_mangle]
pub extern "C" fn hc_variant_stalemate_rule(v: u32) -> u32 {
    match Variant::from_index(v) {
        Some(var) => var.stalemate_rule() as u32,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn hc_new(variant: u32) -> *mut Game {
    match Variant::from_index(variant) {
        Some(v) => Box::into_raw(Box::new(Game::new(v))),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn hc_destroy(g: *mut Game) {
    if !g.is_null() {
        // SAFETY: pointer from `hc_new`, destroyed once.
        drop(unsafe { Box::from_raw(g) });
    }
}

#[no_mangle]
pub extern "C" fn hc_reset(g: *mut Game, variant: u32) -> i32 {
    match (game_ref(g), Variant::from_index(variant)) {
        (Some(game), Some(v)) => {
            game.reset(v);
            1
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn hc_variant(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.variant() as u32)
}

#[no_mangle]
pub extern "C" fn hc_load_fen(g: *mut Game, ptr: *const u8, len: u32) -> i32 {
    let Some(game) = game_ref(g) else { return 0 };
    let result = match input_str(ptr, len) {
        Some(fen) => game.load_fen(fen).map_err(|e| e.to_string()),
        None => Err("FEN is not valid UTF-8".to_string()),
    };
    match result {
        Ok(()) => {
            LAST_ERROR.with(|e| e.borrow_mut().clear());
            1
        }
        Err(msg) => {
            LAST_ERROR.with(|e| *e.borrow_mut() = msg);
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn hc_fen(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| put_str(&game.fen()))
}

#[no_mangle]
pub extern "C" fn hc_start_fen(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| put_str(game.start_fen()))
}

#[no_mangle]
pub extern "C" fn hc_board_ptr(g: *mut Game) -> *const i8 {
    game_ref(g).map_or(core::ptr::null(), |game| game.position().board().as_ptr())
}

#[no_mangle]
pub extern "C" fn hc_turn(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.position().side_to_move() as u32)
}

#[no_mangle]
pub extern "C" fn hc_status(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.status() as u32)
}

#[no_mangle]
pub extern "C" fn hc_in_check(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.position().in_check() as u32)
}

#[no_mangle]
pub extern "C" fn hc_king_cell(g: *mut Game, color: u32) -> i32 {
    match game_ref(g) {
        Some(game) if color < 2 => game.position().king_cell(color as usize).map_or(-1, |c| c as i32),
        _ => -1,
    }
}

#[no_mangle]
pub extern "C" fn hc_ep_cell(g: *mut Game) -> i32 {
    game_ref(g).and_then(|game| game.position().ep_capture_cell()).map_or(-1, |c| c as i32)
}

#[no_mangle]
pub extern "C" fn hc_halfmove_clock(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.position().halfmove_clock())
}

#[no_mangle]
pub extern "C" fn hc_fullmove_number(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.position().fullmove_number())
}

#[no_mangle]
pub extern "C" fn hc_gen_moves(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.gen_moves_into_buffer() as u32)
}

#[no_mangle]
pub extern "C" fn hc_moves_ptr(g: *mut Game) -> *const u32 {
    game_ref(g).map_or(core::ptr::null(), |game| game.move_buffer().as_ptr())
}

#[no_mangle]
pub extern "C" fn hc_make_move(g: *mut Game, mv: u32) -> i32 {
    game_ref(g).map_or(0, |game| game.make_move(Move(mv)) as i32)
}

#[no_mangle]
pub extern "C" fn hc_undo(g: *mut Game) -> i32 {
    game_ref(g).map_or(0, |game| game.undo() as i32)
}

#[no_mangle]
pub extern "C" fn hc_move_san(g: *mut Game, mv: u32) -> u32 {
    match game_ref(g).and_then(|game| game.san(Move(mv))) {
        Some(s) => put_str(&s),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn hc_parse_move(g: *mut Game, ptr: *const u8, len: u32) -> u32 {
    let Some(game) = game_ref(g) else { return 0 };
    match input_str(ptr, len) {
        Some(text) => game.parse_move(text).map_or(0, |m| m.0),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn hc_history_len(g: *mut Game) -> u32 {
    game_ref(g).map_or(0, |game| game.history().len() as u32)
}

#[no_mangle]
pub extern "C" fn hc_history_move(g: *mut Game, i: u32) -> u32 {
    game_ref(g).and_then(|game| game.history().get(i as usize)).map_or(0, |e| e.mv.0)
}

#[no_mangle]
pub extern "C" fn hc_history_san(g: *mut Game, i: u32) -> u32 {
    match game_ref(g).and_then(|game| game.history().get(i as usize)) {
        Some(e) => put_str(&e.san),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn hc_perft(g: *mut Game, depth: u32) -> u64 {
    game_ref(g).map_or(0, |game| game.position().clone().perft(depth))
}

/// Static evaluation in centipawns from WHITE's point of view ([`eval::evaluate`]; the
/// search's tempo bonus is not included, so both start positions evaluate to 0).
#[no_mangle]
pub extern "C" fn hc_eval(g: *mut Game) -> i32 {
    game_ref(g).map_or(0, |game| eval::evaluate(game.position()))
}

/// Best legal move for the side to move ([`search::search`], SPEC §7 / §10), or 0 iff the
/// game is over (or `g` is null), in which case the info buffer is zeroed. The game is not
/// modified. `max_depth` 0 = unlimited (time-bounded), `time_ms` 0 = unlimited
/// (depth-bounded); both 0 = depth [`search::MAX_DEPTH`] capped at
/// [`search::DEFAULT_TIME_MS`] ms. Depth 1 always completes, so a move is returned even if
/// the time runs out. `noise_cp` > 0 plays deliberately weaker (deterministic per `seed`).
/// Depth-bounded searches (`time_ms` 0) are fully deterministic.
#[no_mangle]
pub extern "C" fn hc_search(g: *mut Game, max_depth: u32, time_ms: u32, noise_cp: u32, seed: u32) -> u32 {
    let Some(game) = game_ref(g) else {
        write_info(&search::SearchInfo::default());
        return 0;
    };
    if game.status() != Status::Ongoing {
        write_info(&search::SearchInfo::default());
        return 0;
    }
    let limits = search::SearchLimits { max_depth, time_ms, noise_cp, seed };
    let result = search::search(game, &limits);
    write_info(&result.info);
    result.best.0
}

/// The info of the last `hc_search` (38 `i32`s): `[0]` depth completed, `[1]` score in
/// centipawns from the side to move's point of view (mate = ±(30000 − plies); a Gliński
/// stalemate ±500), `[2]`/`[3]` nodes low/high 32 bits, `[4]` elapsed ms, `[5]` PV length
/// (1..=32 after a successful search), `[6..6+len]` the PV move codes (a legal sequence
/// starting with the returned move); unused entries are 0.
#[no_mangle]
pub extern "C" fn hc_search_info_ptr() -> *const i32 {
    INFO_BUF.with(|cell| cell.get() as *const i32)
}
