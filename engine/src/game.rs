//! [`Game`] = position + move history (undo, SAN record, repetition, status; SPEC §6).

use crate::movegen::MoveList;
use crate::notation;
use crate::position::*;
use crate::variant::Variant;

/// Game status codes (SPEC §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum Status {
    Ongoing = 0,
    /// The side to move is checkmated (the other side wins).
    Checkmate = 1,
    /// The side to move has no legal move and is not in check (scored per variant).
    Stalemate = 2,
    DrawThreefold = 3,
    DrawFiftyMove = 4,
    DrawInsufficient = 5,
}

/// One played move.
#[derive(Clone, Debug)]
pub struct HistoryEntry {
    /// The full move code (with flags and piece info).
    pub mv: Move,
    pub undo: Undo,
    /// SAN as recorded when the move was played (with `+` / `#`).
    pub san: String,
}

/// A game: start position, current position and history.
pub struct Game {
    pos: Position,
    start: Position,
    start_fen: String,
    history: Vec<HistoryEntry>,
    /// `hashes[i]` = hash after `i` moves; `hashes[0]` = start; last = current.
    hashes: Vec<u64>,
    /// Move buffer exposed through `hc_gen_moves` / `hc_moves_ptr`.
    pub(crate) moves: MoveList,
}

impl Clone for Game {
    fn clone(&self) -> Self {
        Game {
            pos: self.pos.clone(),
            start: self.start.clone(),
            start_fen: self.start_fen.clone(),
            history: self.history.clone(),
            hashes: self.hashes.clone(),
            moves: self.moves.clone(),
        }
    }
}

impl Game {
    /// New game at the variant's start position.
    pub fn new(variant: Variant) -> Game {
        Game::from_position(Position::start(variant))
    }

    /// New game starting from an arbitrary (already validated or deliberately relaxed)
    /// position.
    pub fn from_position(pos: Position) -> Game {
        let start_fen = pos.to_fen();
        let hash = pos.hash();
        Game {
            start: pos.clone(),
            pos,
            start_fen,
            history: Vec::new(),
            hashes: vec![hash],
            moves: MoveList::new(),
        }
    }

    /// New game from a FEN (strict validation, SPEC §5.1).
    pub fn from_fen(fen: &str, variant: Variant) -> Result<Game, FenError> {
        Ok(Game::from_position(Position::from_fen(fen, variant)?))
    }

    /// Restarts at `variant`'s start position.
    pub fn reset(&mut self, variant: Variant) {
        *self = Game::new(variant);
    }

    /// Loads a FEN (strict) as the new start position, clearing the history. On error the
    /// game is unchanged.
    pub fn load_fen(&mut self, fen: &str) -> Result<(), FenError> {
        let pos = Position::from_fen(fen, self.pos.variant())?;
        *self = Game::from_position(pos);
        Ok(())
    }

    // -- accessors ----------------------------------------------------------------------

    #[inline]
    pub fn position(&self) -> &Position {
        &self.pos
    }
    #[inline]
    pub fn variant(&self) -> Variant {
        self.pos.variant()
    }
    #[inline]
    pub fn start_position(&self) -> &Position {
        &self.start
    }
    /// FEN of the start position (normalised by re-serialisation).
    #[inline]
    pub fn start_fen(&self) -> &str {
        &self.start_fen
    }
    /// FEN of the current position.
    pub fn fen(&self) -> String {
        self.pos.to_fen()
    }
    #[inline]
    pub fn history(&self) -> &[HistoryEntry] {
        &self.history
    }
    /// Hashes of every position since the start, the current one last
    /// (`len == history().len() + 1`). Use it for repetition detection in search.
    #[inline]
    pub fn hash_history(&self) -> &[u64] {
        &self.hashes
    }

    /// The legal moves of the current position (regardless of draw rules).
    pub fn legal_moves(&self) -> MoveList {
        self.pos.legal_moves()
    }

    /// Fills the ABI move buffer with the legal moves and returns their count.
    pub fn gen_moves_into_buffer(&mut self) -> usize {
        self.pos.gen_legal(&mut self.moves);
        self.moves.len()
    }

    /// The ABI move buffer.
    pub fn move_buffer(&self) -> &MoveList {
        &self.moves
    }

    /// The legal move whose from/to/promotion match `key & 0xFFFFF`.
    pub fn find_legal(&self, key: u32) -> Option<Move> {
        self.legal_moves().find_key(key)
    }

    // -- playing ------------------------------------------------------------------------

    /// Plays the legal move matching `mv`'s from/to/promotion. Returns false (game
    /// unchanged) if no legal move matches or the game is over.
    pub fn make_move(&mut self, mv: Move) -> bool {
        if self.status() != Status::Ongoing {
            return false;
        }
        let legal = self.pos.legal_moves();
        let Some(m) = legal.find_key(mv.key()) else { return false };
        let san = notation::san_with_legal(&self.pos, m, &legal);
        let undo = self.pos.make(m);
        self.hashes.push(self.pos.hash());
        self.history.push(HistoryEntry { mv: m, undo, san });
        true
    }

    /// Parses and plays a move (SAN or coordinate form). Returns the move played.
    pub fn play(&mut self, text: &str) -> Option<Move> {
        let mv = notation::parse_move(&self.pos, text)?;
        if self.make_move(mv) {
            Some(mv)
        } else {
            None
        }
    }

    /// Takes back the last move. Returns false if there is none.
    pub fn undo(&mut self) -> bool {
        match self.history.pop() {
            Some(e) => {
                self.pos.unmake(e.mv, &e.undo);
                self.hashes.pop();
                true
            }
            None => false,
        }
    }

    /// SAN (with suffix) of a legal move of the current position matching `mv`'s key.
    pub fn san(&self, mv: Move) -> Option<String> {
        let legal = self.pos.legal_moves();
        let m = legal.find_key(mv.key())?;
        Some(notation::san_with_legal(&self.pos, m, &legal))
    }

    /// Parses SAN or coordinate text against the current position.
    pub fn parse_move(&self, text: &str) -> Option<Move> {
        notation::parse_move(&self.pos, text)
    }

    // -- status -------------------------------------------------------------------------

    /// How many times the current position has occurred (including now), counting only
    /// positions since the last irreversible move.
    pub fn repetition_count(&self) -> u32 {
        let n = self.hashes.len() - 1;
        let cur = self.hashes[n];
        let window = (self.pos.halfmove_clock() as usize).min(n);
        let mut count = 1;
        let mut i = 2;
        while i <= window {
            if self.hashes[n - i] == cur {
                count += 1;
            }
            i += 2;
        }
        count
    }

    /// Game status with the SPEC §6 precedence: no legal moves (checkmate / stalemate) >
    /// insufficient material > fifty-move rule > threefold repetition.
    pub fn status(&self) -> Status {
        if !self.pos.has_legal_move() {
            return if self.pos.in_check() { Status::Checkmate } else { Status::Stalemate };
        }
        if self.pos.is_insufficient_material() {
            return Status::DrawInsufficient;
        }
        if self.pos.halfmove_clock() >= 100 {
            return Status::DrawFiftyMove;
        }
        if self.repetition_count() >= 3 {
            return Status::DrawThreefold;
        }
        Status::Ongoing
    }
}
