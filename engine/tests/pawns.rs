//! Pawn rules (SPEC §2.1–§2.4): double steps, captures, en passant, promotion.
mod common;

use common::*;
use hexchess_engine::*;

const G: Variant = Variant::Glinski;
const M: Variant = Variant::McCooey;

#[test]
fn glinski_capture_directions() {
    let p = pos("Kg1 kg10 Pe4 pd4 pf5 pe5", "w - 0 1", G);
    // White captures NW (e4->d4) and NE (e4->f5); never straight ahead.
    assert_eq!(moves_from(&p, "e4"), vec!["e4d4", "e4f5"]);
    let p = pos("Kg1 kg10 pe7 Pd6 Pf7 Pe6", "b - 0 1", G);
    // Black captures SW (e7->d6) and SE (e7->f7).
    assert_eq!(moves_from(&p, "e7"), vec!["e7d6", "e7f7"]);
}

#[test]
fn mccooey_capture_directions_are_never_blocked() {
    // White captures NNW (e4->d5) and NNE (e4->f6) even with e5/d4/f5 occupied.
    let p = pos("Kg1 kg10 Pe4 pd5 pf6 pe5 pd4 pf5", "w - 0 1", M);
    assert_eq!(moves_from(&p, "e4"), vec!["e4d5", "e4f6"]);
    // Black captures SSW (e7->d5) and SSE (e7->f6).
    let p = pos("Kg1 kg10 pe7 Pd5 Pf6 Pe6", "b - 0 1", M);
    assert_eq!(moves_from(&p, "e7"), vec!["e7d5", "e7f6"]);
}

#[test]
fn glinski_e4xf5_then_double_step_from_another_pawns_start_cell() {
    let mut p = pos("Kg1 kg10 Pe4 pf5", "w - 0 1", G);
    let m = play(&mut p, "exf5");
    assert!(m.is_capture() && m.captured() == PAWN);
    play(&mut p, "Kh9");
    // f5 is the f-pawn's start cell: the capturing pawn may now double step.
    let dbl = notation::parse_move(&p, "f5f7").expect("f5-f7 must be legal");
    assert!(dbl.is_double_step());
    assert_eq!(moves_from(&p, "f5"), vec!["f5f6", "f5f7"]);
    p.make(dbl);
    assert_eq!(p.ep_cell(), Some(cell("f6")));
    assert!(p.to_fen().contains(" b f6 "));
    // Blocked double step: f7 occupied.
    let p = pos("Kg1 kg10 Pf5 nf7", "w - 0 1", G);
    assert_eq!(moves_from(&p, "f5"), vec!["f5f6"]);
    // Another pawn's start cell: b1xc2 then c2-c4.
    let mut p = pos("Kg1 kg10 Pb1 nc2", "w - 0 1", G);
    play(&mut p, "b1xc2");
    play(&mut p, "Kh9");
    assert!(notation::parse_move(&p, "c2c4").unwrap().is_double_step());
}

#[test]
fn pawn_off_its_start_cells_cannot_double_step() {
    let p = pos("Kg1 kg10 Pe5", "w - 0 1", G);
    assert_eq!(moves_from(&p, "e5"), vec!["e5e6"]);
    let p = pos("Kg1 kg10 Pe4", "w - 0 1", M); // e3 is McCooey's double-step cell, not e4
    assert_eq!(moves_from(&p, "e4"), vec!["e4e5"]);
}

#[test]
fn glinski_c7c5_answered_by_b5xc6_en_passant() {
    let mut p = pos("Kg1 kg10 Pb5 pc7", "b - 0 1", G);
    let before = p.clone();
    let dbl = notation::parse_move(&p, "c7-c5").unwrap();
    assert!(dbl.is_double_step());
    let dbl_undo = p.make(dbl);
    assert_eq!(p.ep_cell(), Some(cell("c6")));
    assert_eq!(p.ep_capture_cell(), Some(cell("c6")));
    let ep = notation::parse_move(&p, "bxc6").expect("e.p. capture");
    assert!(ep.is_en_passant() && ep.is_capture());
    assert_eq!(ep.captured(), PAWN);
    assert_eq!(notation::move_to_san(&p, ep), "bxc6");
    let snapshot = p.clone();
    let undo = p.make(ep);
    assert_eq!(p.piece_at(cell("c6")), PAWN as i8);
    assert_eq!(p.piece_at(cell("c5")), 0, "the double-stepped pawn is removed");
    assert_eq!(p.piece_at(cell("b5")), 0);
    assert_eq!(p.hash(), p.compute_hash());
    p.unmake(ep, &undo);
    assert_eq!(p, snapshot);
    p.unmake(dbl, &dbl_undo);
    assert_eq!(p, before);
}

#[test]
fn mccooey_e8e6_answered_by_d5xe7_en_passant() {
    let mut p = pos("Kg1 kg10 Pd5 pe8", "b - 0 1", M);
    play(&mut p, "e8e6");
    assert_eq!(p.ep_capture_cell(), Some(cell("e7")));
    let ep = notation::parse_move(&p, "dxe7").expect("e.p. capture");
    assert!(ep.is_en_passant());
    p.make(ep);
    assert_eq!(p.piece_at(cell("e7")), PAWN as i8);
    assert_eq!(p.piece_at(cell("e6")), 0);
    assert_eq!(p.hash(), p.compute_hash());
}

#[test]
fn mccooey_centre_pawn_cannot_double_step() {
    let p = Position::start(M);
    assert_eq!(moves_from(&p, "f4"), vec!["f4f5"]);
    let mut p = Position::start(M);
    play(&mut p, "e3e4");
    assert_eq!(moves_from(&p, "f8"), vec!["f8f7"]);
    // The other McCooey pawns can.
    let p = Position::start(M);
    for (from, two) in [("c1", "c3"), ("d2", "d4"), ("e3", "e5"), ("g3", "g5"), ("h2", "h4"), ("i1", "i3")] {
        assert!(moves_from(&p, from).contains(&format!("{from}{two}")), "{from}");
    }
}

#[test]
fn en_passant_right_lasts_exactly_one_ply() {
    let mut p = pos("Kg1 kg10 Pb5 pc7", "b - 0 1", G);
    play(&mut p, "c7c5");
    assert!(p.legal_moves().iter().any(|m| m.is_en_passant()));
    play(&mut p, "Kh1");
    play(&mut p, "Kh9");
    assert_eq!(p.ep_cell(), None);
    assert!(!p.legal_moves().iter().any(|m| m.is_en_passant()));
    assert!(notation::parse_move(&p, "bxc6").is_none());
}

#[test]
fn en_passant_exposing_own_king_is_illegal() {
    // a5-b5-c5-d5-e5 is one line: after b5xc6 e.p. both b5 and c5 are empty.
    let mut p = pos("Ka5 Pb5 re5 pc7 kl1", "b - 0 1", G);
    play(&mut p, "c7c5");
    assert_eq!(p.ep_capture_cell(), Some(cell("c6")), "the capture is pseudo-legal");
    assert!(!p.legal_moves().iter().any(|m| m.is_en_passant()));
    let mut pseudo = MoveList::new();
    p.gen_pseudo(&mut pseudo);
    let ep = pseudo.iter().copied().find(|m| m.is_en_passant()).expect("pseudo-legal e.p.");
    assert!(!p.is_legal(ep));
    // Control: without the rook it is legal.
    let mut p = pos("Ka5 Pb5 pc7 kl1", "b - 0 1", G);
    play(&mut p, "c7c5");
    assert!(p.legal_moves().iter().any(|m| m.is_en_passant()));
    // E.p. that parries a check by capturing the checking pawn is legal.
    let mut p = pos("Kb4 Pb5 pc7 kl1", "b - 0 1", G);
    play(&mut p, "c7c5"); // the c5 pawn now attacks b4 (SW)
    assert!(p.in_check());
    let legal = p.legal_moves();
    assert!(legal.iter().any(|m| m.is_en_passant()), "{:?}", legal);
}

#[test]
fn promotion_offers_four_choices_and_is_mandatory() {
    // Gliński: push to f11 and captures on e10 / g10.
    let p = pos("Kb1 ka6 Pf10 re10 ng10", "w - 0 1", G);
    let from_f10: Vec<Move> = p.legal_moves().iter().copied().filter(|m| m.from() == cell("f10")).collect();
    assert_eq!(from_f10.len(), 12);
    assert!(from_f10.iter().all(|m| m.is_promotion() && m.promo() != 0 && m.piece() == PAWN));
    for (to, captured) in [("f11", 0), ("e10", ROOK), ("g10", KNIGHT)] {
        let mut kinds: Vec<usize> = from_f10.iter().filter(|m| m.to() == cell(to)).map(|m| m.promo()).collect();
        kinds.sort();
        assert_eq!(kinds, vec![KNIGHT, BISHOP, ROOK, QUEEN], "{to}");
        assert!(from_f10.iter().filter(|m| m.to() == cell(to)).all(|m| m.captured() == captured && m.is_capture() == (captured != 0)));
    }
    // SAN and parsing.
    let q = from_f10.iter().copied().find(|m| m.to() == cell("f11") && m.promo() == QUEEN).unwrap();
    assert_eq!(notation::move_to_san(&p, q).trim_end_matches(['+', '#']), "f11=Q");
    let n = from_f10.iter().copied().find(|m| m.to() == cell("g10") && m.promo() == KNIGHT).unwrap();
    assert_eq!(notation::move_to_san(&p, n).trim_end_matches(['+', '#']), "fxg10=N");
    assert_eq!(notation::parse_move(&p, "f11=Q"), Some(q));
    assert_eq!(notation::parse_move(&p, "f10f11q"), Some(q));
    assert_eq!(notation::parse_move(&p, "f10-f11=Q"), Some(q));
    assert_eq!(notation::parse_move(&p, "f11"), None, "promotion piece is mandatory");
    assert_eq!(notation::parse_move(&p, "f10f11"), None);
    // The promoted piece replaces the pawn.
    let mut after = p.clone();
    after.make(n);
    assert_eq!(after.piece_at(cell("g10")), KNIGHT as i8);
    assert_eq!(after.pieces(WHITE, PAWN), 0);
    assert_eq!(after.hash(), after.compute_hash());

    // McCooey: push e9-e10 and diagonal capture e9xf11.
    let p = pos("Kb1 kl1 Pe9 bf11", "w - 0 1", M);
    let from_e9: Vec<Move> = p.legal_moves().iter().copied().filter(|m| m.from() == cell("e9")).collect();
    assert_eq!(from_e9.len(), 8);
    assert!(from_e9.iter().all(|m| m.is_promotion()));
    // Black promotes on rank 1.
    let p = pos("Kl6 ka6 pg2", "b - 0 1", G);
    let from_g2: Vec<Move> = p.legal_moves().iter().copied().filter(|m| m.from() == cell("g2")).collect();
    assert_eq!(from_g2.len(), 4);
    assert!(from_g2.iter().all(|m| m.to() == cell("g1") && m.is_promotion()));
}
