//! The C ABI (SPEC §7), called directly as the JS frontend would.
use hexchess_engine::*;

const GLINSKI_START: &str = "b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1";

fn read_str(len: u32) -> String {
    let p = hc_str_ptr();
    assert!(!p.is_null());
    // SAFETY: the engine wrote `len` bytes at `p`.
    String::from_utf8(unsafe { std::slice::from_raw_parts(p, len as usize) }.to_vec()).expect("UTF-8")
}

/// Copies `text` into wasm-style scratch memory (hc_alloc) and calls `f(ptr, len)`.
fn with_input<T>(text: &[u8], f: impl FnOnce(*const u8, u32) -> T) -> T {
    let len = text.len() as u32;
    let buf = hc_alloc(len);
    assert!(!buf.is_null());
    // SAFETY: `buf` has room for `len` bytes.
    unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), buf, text.len()) };
    let r = f(buf, len);
    hc_free(buf, len);
    r
}

fn parse(g: *mut Game, text: &str) -> u32 {
    with_input(text.as_bytes(), |p, l| hc_parse_move(g, p, l))
}

fn moves(g: *mut Game) -> Vec<u32> {
    let n = hc_gen_moves(g);
    let p = hc_moves_ptr(g);
    // SAFETY: the buffer holds `n` moves.
    unsafe { std::slice::from_raw_parts(p, n as usize) }.to_vec()
}

fn board(g: *mut Game) -> Vec<i8> {
    let p = hc_board_ptr(g);
    // SAFETY: 91 bytes.
    unsafe { std::slice::from_raw_parts(p, 91) }.to_vec()
}

fn info() -> Vec<i32> {
    let p = hc_search_info_ptr();
    // SAFETY: 6 + 32 i32s.
    unsafe { std::slice::from_raw_parts(p, 38) }.to_vec()
}

#[test]
fn variants_and_strings() {
    assert_eq!(hc_abi_version(), 1);
    assert_eq!(hc_variant_count(), 2);
    let len = hc_variant_name(0);
    assert_eq!(len, 8, "Gliński is 8 UTF-8 bytes");
    assert_eq!(read_str(len), "Gliński");
    assert_eq!(read_str(hc_variant_name(1)), "McCooey");
    assert_eq!(hc_variant_name(2), 0);
    assert_eq!(hc_variant_stalemate_rule(0), 1);
    assert_eq!(hc_variant_stalemate_rule(1), 0);
    assert_eq!(hc_variant_stalemate_rule(99), 0);
    assert!(hc_new(2).is_null());
    assert!(hc_new(u32::MAX).is_null());
}

#[test]
fn short_game_through_the_abi() {
    let g = hc_new(0);
    assert!(!g.is_null());
    assert_eq!(hc_variant(g), 0);
    assert_eq!(read_str(hc_fen(g)), GLINSKI_START);
    assert_eq!(read_str(hc_start_fen(g)), GLINSKI_START);
    assert_eq!((hc_turn(g), hc_status(g), hc_in_check(g)), (0, 0, 0));
    assert_eq!((hc_halfmove_clock(g), hc_fullmove_number(g), hc_ep_cell(g)), (0, 1, -1));
    assert_eq!((hc_king_cell(g, 0), hc_king_cell(g, 1), hc_king_cell(g, 2)), (51, 60, -1));
    let b = board(g);
    assert_eq!((b[51], b[60], b[33], b[50]), (6, -6, 1, -3)); // Kg1 kg10 Pe4 bf11
    assert_eq!(b.iter().filter(|&&x| x != 0).count(), 36);

    let ms = moves(g);
    assert_eq!(ms.len(), 51);
    for &m in &ms {
        let mv = Move(m);
        assert!(mv.from() < 91 && mv.to() < 91 && mv.from() != mv.to());
        assert_eq!(b[mv.from()] as usize, mv.piece(), "moving piece kind is encoded");
        assert!(hc_move_san(g, m) > 0);
    }
    assert_eq!(hc_eval(g), 0);
    assert_eq!(hc_perft(g, 3), 137_858);
    assert_eq!(hc_perft(g, 0), 1);

    // 1. e4-e6 (double step; nothing can capture en passant).
    let mv = parse(g, "e4e6");
    assert_ne!(mv, 0);
    assert!(Move(mv).is_double_step());
    assert_eq!(read_str(hc_move_san(g, mv)), "e6");
    assert_eq!(hc_make_move(g, mv & 0xFFFFF), 1, "flags are ignored when matching");
    assert_eq!(hc_make_move(g, mv), 0, "e4 is empty now");
    assert_eq!(hc_turn(g), 1);
    assert!(read_str(hc_fen(g)).ends_with(" b e5 0 1"));
    assert_eq!(hc_ep_cell(g), -1);
    assert_eq!(hc_history_len(g), 1);
    assert_eq!(hc_history_move(g, 0), mv);
    assert_eq!(read_str(hc_history_san(g, 0)), "e6");
    assert_eq!(hc_history_move(g, 1), 0);
    assert_eq!(hc_history_san(g, 1), 0);

    // 1... d7-d5: the e6 pawn may capture en passant on d6.
    let mv2 = parse(g, "d5");
    assert_eq!(hc_make_move(g, mv2), 1);
    assert_eq!(hc_ep_cell(g), 26, "d6");
    let ep = parse(g, "exd6");
    assert_ne!(ep, 0);
    assert!(Move(ep).is_en_passant());
    assert!(moves(g).contains(&ep));
    assert_eq!(hc_make_move(g, ep), 1);
    let b = board(g);
    assert_eq!((b[26], b[25]), (1, 0), "white pawn on d6, d5 emptied");
    assert_eq!(read_str(hc_history_san(g, 2)), "exd6");
    assert_eq!(hc_fullmove_number(g), 2);

    // Search never mutates the game and returns a legal move.
    let fen_before = read_str(hc_fen(g));
    let best = hc_search(g, 2, 0, 0, 1);
    assert_ne!(best, 0);
    assert!(moves(g).contains(&best));
    let inf = info();
    assert!(inf[0] >= 1 && inf[5] >= 1 && inf[5] <= 32, "{inf:?}");
    assert_eq!(inf[6] as u32, best);
    assert!(inf[2] > 0 || inf[3] > 0, "node count");
    assert_eq!(read_str(hc_fen(g)), fen_before);
    assert_eq!(hc_history_len(g), 3);
    // Noise is deterministic per seed; time-bounded and unlimited-depth searches work.
    assert_eq!(hc_search(g, 2, 0, 80, 42), hc_search(g, 2, 0, 80, 42));
    assert_ne!(hc_search(g, 0, 30, 0, 0), 0);

    // Undo back to the start.
    assert_eq!(hc_undo(g), 1);
    assert_eq!(hc_undo(g), 1);
    assert_eq!(hc_undo(g), 1);
    assert_eq!(hc_undo(g), 0);
    assert_eq!(read_str(hc_fen(g)), GLINSKI_START);
    hc_destroy(g);
}

#[test]
fn load_fen_reset_and_independent_games() {
    let g = hc_new(0);
    let h = hc_new(1);
    assert_eq!(moves(h).len(), 31);
    assert_eq!(hc_make_move(g, parse(g, "e4e5")), 1);
    // Invalid FEN: rejected, game unchanged, reason available (king rule checked last).
    let fen_before = read_str(hc_fen(g));
    for bad in [&b"not a fen"[..], b"\xff\xfe", b"K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1"] {
        assert_eq!(with_input(bad, |p, l| hc_load_fen(g, p, l)), 0);
        assert!(hc_last_error() > 0);
        assert_eq!(read_str(hc_fen(g)), fen_before);
        assert_eq!(hc_history_len(g), 1);
    }
    assert!(read_str(hc_last_error()).contains("king"), "the last error explains the king rule");
    // Valid FEN (optional fields omitted): history cleared, becomes the start position.
    let fen = "k/1P1/5/3K3/9/11/11/11/11/11/11 w";
    assert_eq!(with_input(fen.as_bytes(), |p, l| hc_load_fen(g, p, l)), 1);
    assert_eq!(hc_last_error(), 0);
    assert_eq!(hc_history_len(g), 0);
    assert_eq!(read_str(hc_start_fen(g)), "k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1");
    assert_eq!(hc_variant(g), 0);
    // Reset.
    assert_eq!(hc_reset(g, 7), 0);
    assert_eq!(hc_history_len(g), 0, "bad variant leaves the game unchanged");
    assert_eq!(read_str(hc_fen(g)), "k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1");
    assert_eq!(hc_reset(g, 1), 1);
    assert_eq!(hc_variant(g), 1);
    assert_eq!(moves(g).len(), 31);
    assert_eq!(hc_perft(h, 2), 947);
    hc_destroy(g);
    hc_destroy(h);
}

#[test]
fn search_and_make_move_refuse_finished_games() {
    let g = hc_new(0);
    // Checkmated side to move (fool's mate final position).
    let mate = "b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4";
    assert_eq!(with_input(mate.as_bytes(), |p, l| hc_load_fen(g, p, l)), 1);
    assert_eq!(hc_status(g), 1);
    assert_eq!(hc_search(g, 3, 0, 0, 0), 0);
    assert_eq!(info()[0..6], [0, 0, 0, 0, 0, 0]);
    assert_eq!(hc_gen_moves(g), 0);
    // Stalemate.
    let stalemate = "k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1";
    assert_eq!(with_input(stalemate.as_bytes(), |p, l| hc_load_fen(g, p, l)), 1);
    assert_eq!(hc_status(g), 2);
    assert_eq!(hc_search(g, 3, 0, 0, 0), 0);
    // Insufficient material: legal moves exist, but the game is over.
    let kk = "k/3/5/7/9/11/11/11/11/11/K10 w - 0 1";
    assert_eq!(with_input(kk.as_bytes(), |p, l| hc_load_fen(g, p, l)), 1);
    assert_eq!(hc_status(g), 5);
    let n = hc_gen_moves(g);
    assert!(n > 0, "gen_moves ignores draw rules");
    let first = moves(g)[0];
    assert_eq!(hc_make_move(g, first), 0);
    assert_eq!(hc_search(g, 2, 0, 0, 0), 0);
    hc_destroy(g);
}

#[test]
fn null_handles_never_crash() {
    let n: *mut Game = std::ptr::null_mut();
    hc_destroy(n);
    hc_free(std::ptr::null_mut(), 10);
    assert_eq!(hc_reset(n, 0), 0);
    assert_eq!(hc_variant(n), 0);
    assert_eq!(with_input(GLINSKI_START.as_bytes(), |p, l| hc_load_fen(n, p, l)), 0);
    assert_eq!(hc_fen(n), 0);
    assert_eq!(hc_start_fen(n), 0);
    assert!(hc_board_ptr(n).is_null());
    assert_eq!(hc_turn(n), 0);
    assert_eq!(hc_status(n), 0);
    assert_eq!(hc_in_check(n), 0);
    assert_eq!(hc_king_cell(n, 0), -1);
    assert_eq!(hc_ep_cell(n), -1);
    assert_eq!(hc_halfmove_clock(n), 0);
    assert_eq!(hc_fullmove_number(n), 0);
    assert_eq!(hc_gen_moves(n), 0);
    assert!(hc_moves_ptr(n).is_null());
    assert_eq!(hc_make_move(n, 1234), 0);
    assert_eq!(hc_undo(n), 0);
    assert_eq!(hc_move_san(n, 1234), 0);
    assert_eq!(with_input(b"e4e5", |p, l| hc_parse_move(n, p, l)), 0);
    assert_eq!(hc_history_len(n), 0);
    assert_eq!(hc_history_move(n, 0), 0);
    assert_eq!(hc_history_san(n, 0), 0);
    assert_eq!(hc_perft(n, 3), 0);
    assert_eq!(hc_eval(n), 0);
    assert_eq!(hc_search(n, 1, 0, 0, 0), 0);
    // Null input pointers with a non-zero length are rejected too.
    let g = hc_new(0);
    assert_eq!(hc_parse_move(g, std::ptr::null(), 4), 0);
    assert_eq!(hc_load_fen(g, std::ptr::null(), 4), 0);
    assert_eq!(hc_parse_move(g, std::ptr::null(), 0), 0);
    let p = hc_alloc(0);
    assert!(!p.is_null());
    hc_free(p, 0);
    hc_destroy(g);
}
