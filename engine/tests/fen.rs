//! FEN input/output (SPEC §5.1).
mod common;

use common::*;
use hexchess_engine::*;

const GLINSKI_PIECES: &str = "Kg1 Qe1 Rc1 Ri1 Nd1 Nh1 Bf1 Bf2 Bf3 Pb1 Pc2 Pd3 Pe4 Pf5 Pg4 Ph3 Pi2 Pk1 \
     kg10 qe10 rc8 ri8 nd9 nh9 bf9 bf10 bf11 pb7 pc7 pd7 pe7 pf7 pg7 ph7 pi7 pk7";
const MCCOOEY_PIECES: &str = "Kg1 Qe1 Rd1 Rh1 Ne2 Ng2 Bf1 Bf2 Bf3 Pc1 Pd2 Pe3 Pf4 Pg3 Ph2 Pi1 \
     kg10 qe10 rd9 rh9 ne9 ng9 bf9 bf10 bf11 pc8 pd8 pe8 pf8 pg8 ph8 pi8";

#[test]
fn start_fens_parse_and_reserialise_identically() {
    for v in Variant::ALL {
        let p = Position::from_fen(v.start_fen(), v).unwrap();
        assert_eq!(p.to_fen(), v.start_fen());
        assert_eq!(p, Position::start(v));
        assert_eq!(p.hash(), p.compute_hash());
        assert_eq!(p.side_to_move(), WHITE);
        assert_eq!(p.ep_cell(), None);
        assert_eq!((p.halfmove_clock(), p.fullmove_number()), (0, 1));
    }
    assert_eq!(
        Variant::Glinski.start_fen(),
        "b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1"
    );
    assert_eq!(Variant::McCooey.start_fen(), "b/qbk/rnbnr/ppppppp/9/11/11/5P5/4PBP4/3PNBNP3/2PRQBKRP2 w - 0 1");
}

#[test]
fn start_fens_match_the_spec_piece_lists() {
    assert_eq!(fen(GLINSKI_PIECES, "w - 0 1"), Variant::Glinski.start_fen());
    assert_eq!(fen(MCCOOEY_PIECES, "w - 0 1"), Variant::McCooey.start_fen());
    let g = Position::start(Variant::Glinski);
    assert_eq!(g.piece_at(cell("g1")), KING as i8);
    assert_eq!(g.piece_at(cell("g10")), -(KING as i8));
    assert_eq!(g.king_cell(WHITE), Some(cell("g1")));
    assert_eq!(g.king_cell(BLACK), Some(cell("g10")));
    assert_eq!(g.pieces(WHITE, PAWN).count_ones(), 9);
    assert_eq!(g.occupied().count_ones(), 36);
    let m = Position::start(Variant::McCooey);
    assert_eq!(m.pieces(BLACK, PAWN).count_ones(), 7);
    assert_eq!(m.occupied().count_ones(), 32);
}

#[test]
fn empty_board_fen() {
    let empty = "1/3/5/7/9/11/11/11/11/11/11 w - 0 1";
    // No kings: rejected by the strict (hc_load_fen) parser, accepted by the relaxed one.
    assert_eq!(Position::from_fen(empty, Variant::Glinski), Err(FenError::KingCount));
    let p = Position::from_fen_relaxed(empty, Variant::Glinski).unwrap();
    assert_eq!(p.to_fen(), empty);
    assert_eq!(p.occupied(), 0);
    assert_eq!(p.hash(), 0);
    assert!(p.legal_moves().is_empty());
    assert_eq!(board_fen(""), "1/3/5/7/9/11/11/11/11/11/11");
}

#[test]
fn optional_fields_default_and_whitespace() {
    let board = Variant::Glinski.start_fen().split(' ').next().unwrap();
    for f in [format!("{board} w"), format!("  {board}   w  - "), format!("{board} w - 0"), format!("{board}\tw\t-\t0\t1")] {
        let p = Position::from_fen(&f, Variant::Glinski).unwrap_or_else(|e| panic!("{f:?}: {e}"));
        assert_eq!(p.to_fen(), Variant::Glinski.start_fen());
    }
    // Black to move in the start setup is a valid position (White is not in check).
    let p = Position::from_fen(&format!("{board} b - 7 12"), Variant::Glinski).unwrap();
    assert_eq!(p.to_fen(), format!("{board} b - 7 12"));
}

#[test]
fn rejects_malformed_input() {
    let start = Variant::Glinski.start_fen();
    let board = start.split(' ').next().unwrap();
    let cases: Vec<(String, FenError)> = vec![
        (String::new(), FenError::MissingBoard),
        (board.to_string(), FenError::MissingSide),
        (format!("{board} w - 0 1 extra"), FenError::TooManyFields),
        // wrong rank counts
        ("b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2 w - 0 1".to_string(), FenError::WrongRankCount),
        (format!("{board}/11 w - 0 1"), FenError::WrongRankCount),
        // wrong cell counts
        ("b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP w - 0 1".to_string(), FenError::WrongCellCount { rank: 1 }),
        ("b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP11 w - 0 1".to_string(), FenError::WrongCellCount { rank: 1 }),
        ("b/qbk/n1b1n/r5r/ppppppppp/12/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1".to_string(), FenError::WrongCellCount { rank: 6 }),
        ("b1/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1".to_string(), FenError::WrongCellCount { rank: 11 }),
        ("b/qbk/n1b1n/r5r/ppppppppp/011/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1".to_string(), FenError::WrongCellCount { rank: 6 }),
        // bad characters
        ("b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1X4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 w - 0 1".to_string(), FenError::BadChar('X')),
        ("b/qbk/n1b1n/r5r/ppppppppp/11/5P5/4P1P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 x - 0 1".to_string(), FenError::BadSide),
        (format!("{board} w f13 0 1"), FenError::BadEpCell),
        (format!("{board} w j5 0 1"), FenError::BadEpCell),
        (format!("{board} w e 0 1"), FenError::BadEpCell),
        (format!("{board} w - -1 1"), FenError::BadHalfmove),
        (format!("{board} w - x 1"), FenError::BadHalfmove),
        (format!("{board} w - 0 0"), FenError::BadFullmove),
        (format!("{board} w - 0 one"), FenError::BadFullmove),
        // kings
        (fen("Kg1", "w - 0 1"), FenError::KingCount),
        (fen("kg10", "w - 0 1"), FenError::KingCount),
        (fen("Kg1 Ka1 kg10", "w - 0 1"), FenError::KingCount),
        (fen("Kg1 kg10 kl6", "w - 0 1"), FenError::KingCount),
        // pawns on their own promotion cells
        (fen("Kg1 kg10 Pa6", "w - 0 1"), FenError::PawnOnPromotionCell),
        (fen("Kg1 kg10 Pf11", "w - 0 1"), FenError::PawnOnPromotionCell),
        (fen("Kg1 kg10 pf1", "w - 0 1"), FenError::PawnOnPromotionCell),
        (fen("Kg1 kg10 pl1", "b - 0 1"), FenError::PawnOnPromotionCell),
        // side NOT to move in check
        (fen("Kg1 kg10 Rg5", "w - 0 1"), FenError::OpponentInCheck),
        (fen("Kg1 kg10 rg5", "b - 0 1"), FenError::OpponentInCheck),
        (fen("Kf6 kg6", "w - 0 1"), FenError::OpponentInCheck), // adjacent kings
    ];
    for (f, err) in cases {
        assert_eq!(Position::from_fen(&f, Variant::Glinski), Err(err.clone()), "{f:?}");
        // Errors have a human-readable message.
        assert!(!err.to_string().is_empty());
    }
    // A white pawn on rank 1 or a black pawn on White's promotion row is fine.
    assert!(Position::from_fen(&fen("Kg1 kg10 Pa1 pf11", "w - 0 1"), Variant::Glinski).is_ok());
    // The side to move may be in check.
    assert!(Position::from_fen(&fen("Kg1 kg10 Rg5", "b - 0 1"), Variant::Glinski).is_ok());
    // Relaxed parsing accepts what the strict one rejects for rule reasons only.
    assert!(Position::from_fen_relaxed(&fen("Kg1", "w - 0 1"), Variant::Glinski).is_ok());
    assert!(Position::from_fen_relaxed(&fen("Kg1 kg10 Pf11", "w - 0 1"), Variant::Glinski).is_ok());
    assert_eq!(Position::from_fen_relaxed(&fen("Kg1 Ka1", "w - 0 1"), Variant::Glinski), Err(FenError::KingCount));
}

#[test]
fn black_to_move_and_counters_round_trip() {
    let f = fen("Kg1 kg10 Pe4 pe7", "b - 7 12");
    let p = Position::from_fen(&f, Variant::Glinski).unwrap();
    assert_eq!(p.to_fen(), f);
    assert_eq!(p.side_to_move(), BLACK);
    assert_eq!((p.halfmove_clock(), p.fullmove_number()), (7, 12));
    assert_ne!(p.hash(), Position::from_fen(&fen("Kg1 kg10 Pe4 pe7", "w - 7 12"), Variant::Glinski).unwrap().hash());
}

#[test]
fn ep_field_semantics() {
    let v = Variant::Glinski;
    // Output: written whenever the previous move was a double step, even without a capture.
    let mut p = Position::start(v);
    play(&mut p, "e4e6");
    assert_eq!(p.to_fen(), "b/qbk/n1b1n/r5r/ppppppppp/4P6/5P5/6P4/3P1B1P3/2P2B2P2/1PRNQBKNRP1 b e5 0 1");
    assert_eq!(p.ep_cell(), Some(cell("e5")));
    assert_eq!(p.ep_capture_cell(), None, "no black pawn attacks e5");
    // ...and then the hash ignores it (same key as the identical FEN without ep).
    let no_ep = Position::from_fen(&p.to_fen().replace(" e5 ", " - "), v).unwrap();
    assert_eq!(p.hash(), no_ep.hash());
    assert_eq!(p.hash(), p.compute_hash());

    // Input: consistent ep with a possible capture is kept and hashed.
    let with_ep = fen("Kg1 kg10 Pb5 pc5", "w c6 0 1");
    let p = Position::from_fen(&with_ep, v).unwrap();
    assert_eq!(p.ep_cell(), Some(cell("c6")));
    assert_eq!(p.ep_capture_cell(), Some(cell("c6")));
    assert_eq!(p.to_fen(), with_ep);
    let without = Position::from_fen(&fen("Kg1 kg10 Pb5 pc5", "w - 0 1"), v).unwrap();
    assert_ne!(p.hash(), without.hash());
    assert!(p.legal_moves().iter().any(|m| m.is_en_passant()));
    assert!(!without.legal_moves().iter().any(|m| m.is_en_passant()));

    // Consistent ep without a capturing pawn: kept for output, not hashed.
    let p = Position::from_fen(&fen("Kg1 kg10 Pa4 pc5", "w c6 0 1"), v).unwrap();
    assert_eq!(p.ep_cell(), Some(cell("c6")));
    assert_eq!(p.ep_capture_cell(), None);
    assert_eq!(p.hash(), Position::from_fen(&fen("Kg1 kg10 Pa4 pc5", "w - 0 1"), v).unwrap().hash());

    // Inconsistent ep fields are silently ignored.
    for bad in [
        fen("Kg1 kg10 Pb5 pc5", "w c7 0 1"),     // no pawn on c7+forward(black)=c6
        fen("Kg1 kg10 Pb5 pc5 nc6", "w c6 0 1"), // ep cell occupied
        fen("Kg1 kg10 Pb5 pc5 nc7", "w c6 0 1"), // origin cell occupied
        fen("Kg1 kg10 Pb5 Pc5", "w c6 0 1"),     // pawn of the wrong colour
        fen("Kg1 kg10 Pb5 pc5", "b c6 0 1"),     // the side to move made the "double step"
    ] {
        let p = Position::from_fen_relaxed(&bad, v).unwrap();
        assert_eq!(p.ep_cell(), None, "{bad}");
        assert_eq!(p.to_fen(), bad.replace(" c6 ", " - ").replace(" c7 ", " - "));
    }
    // An invalid cell name is an error.
    assert_eq!(Position::from_fen(&fen("Kg1 kg10", "w z9 0 1"), v), Err(FenError::BadEpCell));
}
