//! Search contract (independent of the search implementation): legal result, no mutation of
//! the game, mate in one found with the SPEC §7 mate score, 0 when the game is over.
use hexchess_engine::search::{search, SearchLimits};
use hexchess_engine::*;

fn limits(max_depth: u32, time_ms: u32) -> SearchLimits {
    SearchLimits { max_depth, time_ms, noise_cp: 0, seed: 0 }
}

#[test]
fn finds_glinski_fools_mate_in_one() {
    let mut game = Game::new(Variant::Glinski);
    for m in ["Qc3", "Qc6", "b2", "b6", "Bb1", "e6"] {
        game.play(m).unwrap();
    }
    let before = game.fen();
    for depth in 1..=3 {
        let r = search(&game, &limits(depth, 0));
        assert_eq!(game.san(r.best).unwrap(), "Qxf9#", "depth {depth}");
        assert_eq!(r.info.score, 30000 - 1, "mate in 1 ply from the side to move");
        assert_eq!(r.info.pv.first().copied(), Some(r.best));
    }
    assert_eq!(game.fen(), before);
    assert_eq!(game.history().len(), 6);
}

#[test]
fn finds_black_mate_in_one_in_mccooey() {
    // McCooey game 2 before 21... Qj1 mate (our letters: Qk1#).
    let moves = "g5 g6 d4 c6 Ne4 Ng7 Ng4 i6 Bd3 Ri8 Bg3 Nk7 c3 Ni4 Kf2 Ri7 Nh3 Ra2 Be2 Bg8 Rg2 Nl4 \
                 Nh1 Bg7 e5 Bk3 Bi5 Bxi5 Nxi5 Qg9 Nh3 Qk3 Ng4 Qh4 Kh1 Nh5 Nd3 Nxf4 Bxf4 Qk3 i2";
    let mut game = Game::new(Variant::McCooey);
    for m in moves.split_whitespace() {
        game.play(m).unwrap_or_else(|| panic!("{m}"));
    }
    let r = search(&game, &limits(2, 0));
    assert_eq!(game.san(r.best).unwrap(), "Qk1#");
}

#[test]
fn respects_time_and_returns_a_legal_move() {
    let game = Game::new(Variant::Glinski);
    let legal = game.legal_moves();
    for (d, t) in [(1, 0), (0, 50), (3, 0), (2, 1)] {
        let r = search(&game, &limits(d, t));
        assert!(legal.contains(&r.best), "depth {d} time {t}");
        assert!(r.info.depth >= 1);
    }
    let r = search(&game, &SearchLimits { max_depth: 2, time_ms: 0, noise_cp: 300, seed: 9 });
    assert!(legal.contains(&r.best));
}

#[test]
fn no_move_without_legal_moves() {
    let fen = "b/1bk/n1Q1n/r5r/1pp1ppppp/1pq1p6/5P5/4P1P4/3P3P3/1PP2B2P2/1BRN1BKNRP1 b - 0 4";
    let game = Game::from_fen(fen, Variant::Glinski).unwrap();
    assert!(search(&game, &limits(3, 0)).best.is_none());
}
