//! Perft divide: `cargo run --release --example divide -- <variant 0|1> <depth> ["FEN"]`
//! Prints a JSON object {coord-move: count} (for cross-checking with other implementations).
use hexchess_engine::{Position, Variant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let variant = Variant::from_index(args.first().and_then(|s| s.parse().ok()).unwrap_or(0)).expect("variant 0 or 1");
    let depth: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mut pos = match args.get(2) {
        Some(fen) => Position::from_fen_relaxed(fen, variant).expect("valid FEN"),
        None => Position::start(variant),
    };
    let mut parts: Vec<(String, u64)> = pos.perft_divide(depth).into_iter().map(|(m, n)| (m.to_coord(), n)).collect();
    parts.sort();
    let total: u64 = parts.iter().map(|p| p.1).sum();
    let body: Vec<String> = parts.iter().map(|(m, n)| format!("\"{m}\": {n}")).collect();
    println!("{{{}}}", body.join(", "));
    eprintln!("total {total}");
}
