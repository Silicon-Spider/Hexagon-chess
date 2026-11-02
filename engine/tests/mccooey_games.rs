//! Replays the published sample games of McCooey's hexagonal chess
//! (chessvariants.com/hexagonal.dir/sample1.html) with the SAN parser.
//!
//! McCooey letters the files a–k WITH j (his j = our k, his k = our l), so lowercase
//! `j` → `k` and `k` → `l` before parsing. Annotations `?`, `!`, `(?)`, `!?` are stripped;
//! `+` must give check, an unannotated move must not, and `mate` must deliver checkmate.
//! Every move must resolve to exactly one legal move, and its capture mark must be exact.
mod common;

use hexchess_engine::notation::{match_pattern, parse_pattern};
use hexchess_engine::*;

const GAMES: &[(&str, &str)] = &[
    (
        "A (Haynie-McCooey)",
        "1. Nh4 f7 2. f5 Ne7 3. Nd4 Bj3 4. Rg2 Bxh4 5. gxh4 c6 6. Ng4 Ng5 7. h3 Bi3+ 8. Kh1 Nxf3 \
         9. Qxf3 Bxg4 10. Qxg4 i6 11. Bd3 Qh5 12. Qxh5 ixh5 13. Rdg3 Rk6 14. e4 Ng7 15. Rj2 Nxf5 \
         16. Rg6 Ni3+ 17. Kg1 Nxg6 18. hxg6 Rxg6+ 19. resigns",
    ),
    (
        "B (Haynie-McCooey)",
        "1. f5 g6 2. Nd4 Bh6 3. fxg6 fxg6 4. Ne4 Nd6 5. Bd3 Nxe4 6. Bxe4 Bf7 7. Bxf7 Nxf7 \
         8. Nxf7 exf7 9. Kf1 Qe5 10. g4 Bb3 11. Rdf3 Be7 12. Bg3 Ra4 13. Rhg2 Ra1 14. Kg1 Ri6 \
         15. i2 Rj5 16. Rh1 Rxe4 17. Qg2? Rc4 18. resigns",
    ),
    (
        "C (McCooey-Haynie)",
        "1. g5 f7 2. Ne4 fxg5? 3. Ng6! Ne7 4. Ni7+ Kg9 5. Bi5+ h7 6. Be6+ Kh8 7. Bj7+ Kg7 \
         8. Qh5 mate",
    ),
    (
        "D (McCooey-Haynie)",
        "1. d4 f7 2. e5 fxe5 3. fxe5 Nh6 4. Ne4 Ng7 5. Be3 e6 6. d5 Nxe5 7. Bj5 Rg9 8. g5 Nxf3 \
         9. Qxf3 Nf5 10. Ng6 Nxe2? 11. Ni7+ Kh9 12. Nf8 mate",
    ),
    (
        "1 (McCooey-O'Lena)",
        "1. g5 Ne7 2. Nh4 d6 3. Nk3 Bh7 4. Ng4 g6 5. c3 Bg8 6. Ra1 f7 7. Bg3 fxg5 8. Bd5 Nh6 \
         9. fxg5 Bxd5+ 10. cxd5 Nxg4 11. Qxg4 Qg7 12. Qe7+ Kg9 13. Be6+ Bf8 14. Bxf8+ Qxf8 \
         15. Qxf8+ Kxf8 16. Nh5+ Kg7 17. Nxg8 Kxg8 18. Bd3+ Kg7 19. Bxh9 Nxh9 20. h4 gxh4 \
         21. Rh6+ Kg8 22. R1xh4 Re10 23. Ri4 Ng7 24. Re7+ Kf9 25. Rf6+ Kd8 26. Rff8 Nj5 \
         27. Rxd6+ Ke9 28. Rg8+ resigns",
    ),
    (
        "2 (O'Lena-McCooey)",
        "1. g5 g6 2. d4 c6 3. Ne4 Ng7 4. Ng4 i6 5. Bd3 Ri8 6. Bg3 Nj7 7. c3 Ni4 8. Kf2 Ri7 \
         9. Nh3 Ra2+ 10. Be2 Bg8 11. Rg2 Nk4 12. Nh1 Bg7 13. e5 Bj3 14. Bi5 Bxi5+ 15. Nxi5 Qg9 \
         16. Nh3 Qj3 17. Ng4 Qh4+ 18. Kh1 Nh5 19. Nd3(?) Nxf4+! 20. Bxf4 Qj3+ 21. i2 Qj1 mate",
    ),
];

/// McCooey's file letters → ours.
fn convert(token: &str) -> String {
    token
        .chars()
        .map(|c| match c {
            'j' => 'k',
            'k' => 'l',
            c => c,
        })
        .collect()
}

fn strip_annotations(token: &str) -> String {
    let mut t = token.to_string();
    for a in ["(?)", "(!)", "!?", "?!", "??", "!!", "?", "!"] {
        t = t.replace(a, "");
    }
    t
}

struct Replay {
    plies: usize,
    final_status: Status,
    san_differences: Vec<String>,
}

fn replay(name: &str, text: &str) -> Replay {
    let mut game = Game::new(Variant::McCooey);
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut san_differences = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.ends_with('.') && tok[..tok.len() - 1].bytes().all(|b| b.is_ascii_digit()) {
            continue; // move number
        }
        if tok == "resigns" {
            break;
        }
        assert_ne!(tok, "mate", "{name}: stray 'mate'");
        let mate = tokens.get(i) == Some(&"mate");
        let clean = strip_annotations(tok);
        let check = clean.ends_with('+');
        let source = convert(clean.trim_end_matches('+'));
        let ctx = format!("{name}: ply {} '{tok}' ({source}) in {}", game.history().len() + 1, game.fen());

        // Exactly one legal move must match (strict: exact capture marking too).
        let pat = parse_pattern(&source).unwrap_or_else(|| panic!("{ctx}: unparsable"));
        let legal = game.legal_moves();
        let mv = match_pattern(&pat, &legal).unwrap_or_else(|e| panic!("{ctx}: {e:?}; legal: {:?}", legal));
        assert_eq!(pat.capture, mv.is_capture(), "{ctx}: capture mark mismatch");
        assert!(game.make_move(mv), "{ctx}: make_move failed");

        let in_check = game.position().in_check();
        let status = game.status();
        if mate {
            assert_eq!(status, Status::Checkmate, "{ctx}: 'mate' is not checkmate");
            i += 1; // consume "mate"
        } else if check {
            assert!(in_check, "{ctx}: '+' but no check");
            assert_eq!(status, Status::Ongoing, "{ctx}");
        } else {
            assert!(!in_check, "{ctx}: unannotated move gives check");
            assert_eq!(status, Status::Ongoing, "{ctx}");
        }
        // Compare our SAN with the source notation (informational).
        let ours = game.history().last().unwrap().san.trim_end_matches(['+', '#']).to_string();
        if ours != source {
            san_differences.push(format!("{source} -> {ours}"));
        }
    }
    Replay { plies: game.history().len(), final_status: game.status(), san_differences }
}

#[test]
fn published_mccooey_games_replay() {
    let expected_plies = [36, 34, 15, 23, 55, 42];
    for (k, (name, text)) in GAMES.iter().enumerate() {
        let r = replay(name, text);
        println!("game {name}: {} plies, final status {:?}, SAN differences: {:?}", r.plies, r.final_status, r.san_differences);
        assert_eq!(r.plies, expected_plies[k], "{name}");
        assert!(r.san_differences.is_empty(), "{name}: our SAN differs from the source: {:?}", r.san_differences);
    }
}

#[test]
fn file_letter_conversion() {
    assert_eq!(convert("Bj3"), "Bk3");
    assert_eq!(convert("Rk6"), "Rl6");
    assert_eq!(convert("Qj1"), "Qk1");
    assert_eq!(convert("Kh1"), "Kh1");
    assert_eq!(strip_annotations("Nxf4+!"), "Nxf4+");
    assert_eq!(strip_annotations("Nd3(?)"), "Nd3");
    assert_eq!(strip_annotations("fxg5?"), "fxg5");
}
