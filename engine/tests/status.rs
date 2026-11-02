//! Game status (SPEC §2.1, §2.4, §6).
mod common;

use common::*;
use hexchess_engine::*;

fn status_of(fen: &str, variant: Variant) -> (Status, bool) {
    let p = Position::from_fen_relaxed(fen, variant).unwrap_or_else(|e| panic!("{fen}: {e}"));
    let check = p.in_check();
    (Game::from_position(p).status(), check)
}

#[test]
fn hexchess_club_fixtures() {
    let g = Variant::Glinski;
    // These three have no black king (as in hexchess.club), so they need the relaxed parser.
    assert_eq!(status_of("K/3/5/7/9/5r5/11/11/11/11/11 w - 0 1", g), (Status::Ongoing, true));
    assert_eq!(status_of("K/3/5/3q3/2q6/11/11/11/11/11/11 w - 0 1", g), (Status::Ongoing, true));
    assert_eq!(status_of("K/3/2q2/3q3/9/11/11/11/11/11/11 w - 1 2", g), (Status::Checkmate, true));
    assert_eq!(status_of("k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1", g), (Status::Ongoing, false));
    assert_eq!(status_of("k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1", g), (Status::Stalemate, false));
    // The same outcomes with strict parsing (black king added far away where needed).
    for (f, expect) in [
        ("K/3/5/7/9/5r5/11/11/11/11/k10 w - 0 1", Status::Ongoing),
        ("K/3/5/3q3/2q6/11/11/11/11/11/k10 w - 0 1", Status::Ongoing),
        ("K/3/2q2/3q3/9/11/11/11/11/11/k10 w - 1 2", Status::Checkmate),
        ("k/1P1/5/3K3/9/11/11/11/11/11/11 w - 0 1", Status::Ongoing),
        ("k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1", Status::Stalemate),
    ] {
        let game = Game::from_fen(f, g).unwrap_or_else(|e| panic!("{f}: {e}"));
        assert_eq!(game.status(), expect, "{f}");
    }
}

fn abi_str(len: u32) -> String {
    let p = hc_str_ptr();
    // SAFETY: the engine wrote `len` bytes at `p`.
    String::from_utf8(unsafe { std::slice::from_raw_parts(p, len as usize) }.to_vec()).unwrap()
}

fn abi_parse(g: *mut Game, text: &str) -> u32 {
    let len = text.len() as u32;
    let buf = hc_alloc(len);
    // SAFETY: `buf` has `len` writable bytes.
    unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), buf, text.len()) };
    let mv = hc_parse_move(g, buf, len);
    hc_free(buf, len);
    mv
}

#[test]
fn glinski_fools_mate_through_the_abi() {
    let g = hc_new(0);
    let moves = ["Qe1-c3", "Qe10-c6", "b1-b2", "b7-b6", "Bf3-b1", "e7-e6", "Qc3xf9#"];
    let sans = ["Qc3", "Qc6", "b2", "b6", "Bb1", "e6", "Qxf9#"];
    for (i, m) in moves.iter().enumerate() {
        assert_eq!(hc_status(g), Status::Ongoing as u32);
        let code = abi_parse(g, m);
        assert_ne!(code, 0, "{m} must parse");
        assert_eq!(hc_make_move(g, code), 1, "{m}");
        assert_eq!(abi_str(hc_history_san(g, i as u32)), sans[i]);
    }
    assert_eq!(hc_status(g), Status::Checkmate as u32);
    assert_eq!(hc_in_check(g), 1);
    assert_eq!(hc_gen_moves(g), 0);
    assert_eq!(
        abi_str(hc_fen(g)),
        "b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4"
    );
    // No move can be made once the game is over; undo still works.
    assert_eq!(hc_make_move(g, 0), 0);
    assert_eq!(hc_undo(g), 1);
    assert_eq!(hc_status(g), Status::Ongoing as u32);
    hc_destroy(g);
}

#[test]
fn threefold_repetition_triggers_exactly_on_the_third_occurrence() {
    for v in Variant::ALL {
        let mut game = Game::new(v);
        let start = game.position().clone();
        let knight_move = |p: &Position| p.legal_moves().iter().copied().find(|m| m.piece() == KNIGHT).unwrap();
        let w_out = knight_move(game.position());
        assert!(game.make_move(w_out));
        let b_out = knight_move(game.position());
        assert!(game.make_move(b_out));
        let back = |m: Move| Move::new(m.to(), m.from(), 0, 0, KNIGHT, 0);
        let cycle = [back(w_out), back(b_out), w_out, b_out, back(w_out), back(b_out)];
        for (i, &m) in cycle.iter().enumerate() {
            assert_eq!(game.status(), Status::Ongoing, "{v:?} before cycle move {i}");
            assert!(game.make_move(m), "{v:?} {m}");
        }
        // The start position (same pieces and side; clocks differ) now occurred three
        // times: plies 0, 4 and 8.
        assert_eq!(game.position().hash(), start.hash());
        assert_eq!(game.position().board(), start.board());
        assert_eq!(game.repetition_count(), 3);
        assert_eq!(game.status(), Status::DrawThreefold);
        assert!(!game.make_move(w_out), "no moves after a draw");
        assert!(!game.legal_moves().is_empty(), "legal moves are still generated");
        assert!(game.undo());
        assert_eq!(game.status(), Status::Ongoing);
        assert_eq!(game.repetition_count(), 2, "ply 7 repeats ply 3");
    }
}

#[test]
fn fifty_move_rule_and_mate_precedence() {
    let g = Variant::Glinski;
    // Quiet move making the clock 100 -> draw.
    let mut game = Game::from_fen(&fen("Ka1 kf11 Qh8", "w - 99 80"), g).unwrap();
    assert_eq!(game.status(), Status::Ongoing);
    assert!(game.play("Ka2").is_some());
    assert_eq!(game.position().halfmove_clock(), 100);
    assert_eq!(game.status(), Status::DrawFiftyMove);
    // Mate delivered on the 100th ply wins.
    let mut game = Game::from_fen(&fen("Ka1 kf11 Qh8", "w - 99 80"), g).unwrap();
    let mv = game.play("Qf9").expect("Qh8-f9 is legal");
    assert!(!mv.is_capture());
    assert_eq!(game.position().halfmove_clock(), 100);
    assert_eq!(game.status(), Status::Checkmate);
    assert_eq!(game.history()[0].san, "Qf9#");
    // A capture or a pawn move resets the clock.
    let mut game = Game::from_fen(&fen("Ka1 kl6 Qh8 ph5 Pb2", "w - 98 80"), g).unwrap();
    game.play("Qxh5").unwrap();
    assert_eq!(game.position().halfmove_clock(), 0);
    let king_move = game.legal_moves().iter().copied().find(|m| m.piece() == KING).unwrap();
    assert!(game.make_move(king_move));
    assert_eq!(game.position().halfmove_clock(), 1);
    game.play("b3").unwrap();
    assert_eq!(game.position().halfmove_clock(), 0);
}

#[test]
fn insufficient_material() {
    let g = Variant::Glinski;
    for (pieces, draw) in [
        ("Ka1 kl6", true),
        ("Ka1 kl6 Nf6", true),
        ("Ka1 kl6 nf6", true),
        ("Ka1 kl6 Bf6", true),
        ("Ka1 kl6 bf6", true),
        ("Ka1 kl6 Pf5", false),
        ("Ka1 kl6 Rf4", false),
        ("Ka1 kl6 Qf4", false),
        ("Ka1 kl6 Nf6 Nf5", false),
        ("Ka1 kl6 Bf6 bf3", false),
        ("Ka1 kl6 Bf6 nf3", false),
        ("Ka1 kl6 Bf6 Bf5", false),
    ] {
        let game = Game::from_fen(&fen(pieces, "w - 0 1"), g).unwrap();
        let expect = if draw { Status::DrawInsufficient } else { Status::Ongoing };
        assert_eq!(game.status(), expect, "{pieces}");
        assert_eq!(game.position().is_insufficient_material(), draw, "{pieces}");
    }
    // Capturing the last pawn produces the draw (knight f6 jumps (3,-1) to i4).
    let mut game = Game::from_fen(&fen("Ka1 Nf6 kl6 pi4", "w - 0 1"), g).unwrap();
    assert_eq!(game.status(), Status::Ongoing);
    assert!(game.play("Nxi4").is_some());
    assert_eq!(game.status(), Status::DrawInsufficient);
    assert!(!game.make_move(Move::new(0, 1, 0, 0, KING, 0)), "no moves after a draw");
    let mut game = Game::from_fen(&fen("Ka1 Rf5 kl6 pg5", "w - 0 1"), g).unwrap();
    assert!(game.play("Rxg5").is_some());
    assert_eq!(game.status(), Status::Ongoing, "K+R v K is not a dead draw");
}

#[test]
fn stalemate_in_both_variants_and_scoring_rule() {
    let f = "k/1P1/2K2/7/9/11/11/11/11/11/11 b - 1 1";
    for v in Variant::ALL {
        let game = Game::from_fen(f, v).unwrap();
        assert!(!game.position().in_check());
        assert_eq!(game.status(), Status::Stalemate, "{v:?}");
    }
    assert_eq!(hc_variant_stalemate_rule(0), 1, "Gliński: stalemating side scores 3/4");
    assert_eq!(hc_variant_stalemate_rule(1), 0, "McCooey: stalemate is a draw");
    assert_eq!(Variant::Glinski.stalemate_rule(), StalemateRule::ThreeQuarters);
    assert_eq!(Variant::McCooey.stalemate_rule(), StalemateRule::Draw);
    // Stalemate takes precedence over the fifty-move rule.
    let game = Game::from_fen("k/1P1/2K2/7/9/11/11/11/11/11/11 b - 150 90", Variant::McCooey).unwrap();
    assert_eq!(game.status(), Status::Stalemate);
    // A lone queen mates (no-legal-move statuses are evaluated first).
    let game = Game::from_fen(&fen("Ka1 kf11 Qf9", "b - 0 1"), Variant::Glinski).unwrap();
    assert_eq!(game.status(), Status::Checkmate);
}
