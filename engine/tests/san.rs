//! SAN output and move parsing (SPEC §5.2).
mod common;

use common::*;
use hexchess_engine::geometry::*;
use hexchess_engine::*;

const G: Variant = Variant::Glinski;

fn san_of(p: &Position, coord: &str) -> String {
    let mv = p.legal_moves().iter().copied().find(|m| m.to_coord() == coord).unwrap_or_else(|| panic!("{coord} not legal"));
    notation::move_to_san(p, mv)
}

#[test]
fn disambiguation_by_file() {
    // a1 and l1 both reach f1 (along the two halves of the rank-1 chevron) and f6.
    let p = pos("Kc8 kf11 Ra1 Rl1", "w - 0 1", G);
    assert_eq!(san_of(&p, "a1f1"), "Raf1+");
    assert_eq!(san_of(&p, "l1f1"), "Rlf1+");
    assert_eq!(san_of(&p, "a1f6"), "Raf6+");
    assert_eq!(san_of(&p, "l1f6"), "Rlf6+");
    assert_eq!(san_of(&p, "a1a3"), "Ra3");
    let raf1 = notation::parse_move(&p, "Raf1").unwrap();
    assert_eq!(raf1.to_coord(), "a1f1");
    for text in ["Raf1+", "Ra1f1", "Ra1-f1", "a1f1", "a1-f1", "Raf1!", "Raf1?!"] {
        assert_eq!(notation::parse_move(&p, text), Some(raf1), "{text}");
    }
    assert_eq!(notation::parse_move(&p, "Rf1"), None, "ambiguous");
    assert_eq!(notation::parse_move_detailed(&p, "Rf1"), Err(notation::ParseMoveError::Ambiguous));
    assert_eq!(notation::parse_move(&p, "Rxf1"), None, "not a capture");
    assert_eq!(notation::parse_move(&p, "Rf2"), None, "illegal");
    assert_eq!(notation::parse_move_detailed(&p, "Rf2"), Err(notation::ParseMoveError::NoMatch));
}

#[test]
fn disambiguation_by_rank() {
    let p = pos("Ka1 kl6 Rf2 Rf9", "w - 0 1", G);
    assert_eq!(san_of(&p, "f2f5"), "R2f5");
    assert_eq!(san_of(&p, "f9f5"), "R9f5");
    assert_eq!(notation::parse_move(&p, "R2f5").unwrap().to_coord(), "f2f5");
    assert_eq!(notation::parse_move(&p, "Rf5"), None);
    assert_eq!(notation::parse_move(&p, "Rff5"), None, "file alone is still ambiguous");
}

#[test]
fn disambiguation_by_full_cell() {
    // Queens d6, d4 and h6 all reach f6: d6 shares its file with d4 and its rank with h6.
    let queens = "Ka1 Qd6 Qd4 Qh6";
    let mut chosen = None;
    for k in (0..NUM_CELLS).rev() {
        let pieces = format!("{queens} k{}", cell_name(k));
        let f = fen(&pieces, "w - 0 1");
        let Ok(p) = Position::from_fen(&f, G) else { continue };
        let ok = ["d6f6", "d4f6", "h6f6"].iter().all(|c| !san_of(&p, c).ends_with(['+', '#']));
        if ok {
            chosen = Some(p);
            break;
        }
    }
    let p = chosen.expect("some black king cell gives a valid quiet position");
    assert_eq!(san_of(&p, "d6f6"), "Qd6f6");
    assert_eq!(san_of(&p, "d4f6"), "Q4f6");
    assert_eq!(san_of(&p, "h6f6"), "Qhf6");
    assert_eq!(notation::parse_move(&p, "Qd6f6").unwrap().to_coord(), "d6f6");
    assert_eq!(notation::parse_move(&p, "Q4f6").unwrap().to_coord(), "d4f6");
    assert_eq!(notation::parse_move(&p, "Qhf6").unwrap().to_coord(), "h6f6");
    assert_eq!(notation::parse_move(&p, "Qdf6"), None);
    assert_eq!(notation::parse_move(&p, "Q6f6"), None);
    assert_eq!(notation::parse_move(&p, "Qf6"), None);
}

#[test]
fn captures_en_passant_promotions_check_and_mate() {
    let mut p = Position::start(G);
    // Pawn push, double step, piece move.
    assert_eq!(san_of(&p, "e4e5"), "e5");
    assert_eq!(san_of(&p, "e4e6"), "e6");
    assert_eq!(san_of(&p, "d1c3"), "Nc3");
    // Fool's mate: captures with check-mate suffix.
    for m in ["Qc3", "Qc6", "b2", "b6", "Bb1", "e6"] {
        play(&mut p, m);
    }
    assert_eq!(san_of(&p, "c3f9"), "Qxf9#");
    // Pawn capture and en passant.
    let p = pos("Kg1 kg10 Pe4 pf5", "w - 0 1", G);
    assert_eq!(san_of(&p, "e4f5"), "exf5");
    let mut p = pos("Kg1 kg10 Pb5 pc7", "b - 0 1", G);
    play(&mut p, "c5");
    assert_eq!(san_of(&p, "b5c6"), "bxc6");
    assert_eq!(notation::parse_move(&p, "bxc6 e.p.").unwrap().to_coord(), "b5c6");
}

#[test]
fn promotion_san_with_capture_and_check() {
    // Black king b1 is on no line from f11 or e10.
    let p = pos("Kl1 kb1 Pf10 re10", "w - 0 1", G);
    assert_eq!(san_of(&p, "f10f11q"), "f11=Q");
    assert_eq!(san_of(&p, "f10e10q"), "fxe10=Q");
    assert_eq!(san_of(&p, "f10e10n"), "fxe10=N");
    // f11-g10-h9-i8-k7 is a rook line: the new queen checks, the new bishop does not.
    let p = pos("Ka1 kk7 Pf10", "w - 0 1", G);
    assert_eq!(san_of(&p, "f10f11q"), "f11=Q+");
    assert_eq!(san_of(&p, "f10f11b"), "f11=B");
}

#[test]
fn parser_accepts_san_and_coordinate_forms() {
    let p = Position::start(G);
    let e5 = notation::parse_move(&p, "e5").unwrap();
    for text in ["e4e5", "e4-e5", "e5", "Pe5", "Pe4e5", " e4e5 ", "e5+", "e5!?"] {
        assert_eq!(notation::parse_move(&p, text), Some(e5), "{text}");
    }
    assert!(notation::parse_move(&p, "e4e6").unwrap().is_double_step());
    assert_eq!(notation::parse_move(&p, "f2c5"), notation::parse_move(&p, "Bc5"));
    assert!(notation::parse_move(&p, "Bc5").is_some());
    assert_eq!(notation::parse_move(&p, "Bc4"), None, "no bishop reaches c4");

    let p = pos("Kg1 kl6 Be4 pd5", "w - 0 1", G);
    let bxd5 = notation::parse_move(&p, "e4xd5").expect("e4xd5");
    assert!(bxd5.is_capture() && bxd5.piece() == BISHOP);
    for text in ["e4d5", "e4-d5", "e4:d5", "Bxd5", "Bd5", "Be4xd5", "Bexd5", "B4xd5"] {
        assert_eq!(notation::parse_move(&p, text), Some(bxd5), "{text}");
    }
    assert_eq!(notation::move_to_san(&p, bxd5), "Bxd5");

    let p = pos("Kb1 ka6 Pf10", "w - 0 1", G);
    let q = notation::parse_move(&p, "f10f11q").unwrap();
    assert_eq!(q.promo(), QUEEN);
    for text in ["f10-f11=Q", "f10f11Q", "f10-f11=q", "f11=Q", "f11Q", "f11q"] {
        assert_eq!(notation::parse_move(&p, text), Some(q), "{text}");
    }
    assert_eq!(notation::parse_move(&p, "f11=N").unwrap().promo(), KNIGHT);
    assert_eq!(notation::parse_move(&p, "f10f11"), None, "ambiguous promotion");

    let p = Position::start(G);
    for bad in ["", "   ", "xyz", "e4e", "O-O", "0-0", "e4e5e6", "Qj5", "e12", "Q", "=Q", "e4-", "0000", "e4e5k", "Ke9", "e4e7", "e4xe5", "j4", "E4E5"] {
        assert_eq!(notation::parse_move(&p, bad), None, "{bad:?}");
    }
}

#[test]
fn every_legal_move_round_trips_through_san_and_coordinates() {
    for v in Variant::ALL {
        let mut rng = Rng(0x5EED_0000 + v as u64);
        for _game in 0..12 {
            let mut p = Position::start(v);
            for _ply in 0..160 {
                let legal = p.legal_moves();
                if legal.is_empty() {
                    break;
                }
                let mut sans = Vec::with_capacity(legal.len());
                for &m in legal.iter() {
                    let san = notation::san_with_legal(&p, m, &legal);
                    assert_eq!(notation::parse_move(&p, &san), Some(m), "{san} in {}", p.to_fen());
                    assert_eq!(notation::parse_move(&p, &m.to_coord()), Some(m), "{m} in {}", p.to_fen());
                    sans.push(san);
                }
                sans.sort();
                let n = sans.len();
                sans.dedup();
                assert_eq!(sans.len(), n, "duplicate SAN in {}", p.to_fen());
                let m = legal[rng.below(legal.len())];
                p.make(m);
            }
        }
    }
}
