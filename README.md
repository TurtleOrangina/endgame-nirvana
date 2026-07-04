# endgame-nirvana

Endgame Nirvana is a free and open source way to practice your chess endgames. The goal
is to provide the means to practice endgames (because practice makes perfect). This is
achieved by a varied puzzle selection combined with advanced move selection techniques
for the computer side, which aim to:
- Challenge the user to learn the trickier lines. E.g. A strong engine might think a position
  is boring and dead drawn, but we need to test the user in the most challenging ways so
  the user can learn to hold this draw confidently against probing human players.
- Provide variance to computer moves, so not only the most resillient variant is practiced,
  but also other slightly less variants. E.g.: Rook + Bishop vs Rook from the Philidor
  position is won, but there are various defensive paths that the "Rook only" side could take,
  that are not immediately obvious to a human. If you played only against the best move always,
  you would learn one line only, and when a human plays a slightly less optimal move (that is
  mate in 12 instead of mate in 16), you haven't practiced it. We fix this by sampling
  randomly from the best moves, and if you retry the position multiple times against the
  computer, you should learn all the important variants.


The project has two independent components:

- [`frontend/`](frontend/README.md) — Vue 3 + TypeScript SPA, the app itself. Works fully
  offline; a backend is only needed for account sync and remote puzzle catalog downloads.
- [`backend/`](backend/README.md) — Self-hosted Supabase stack (Docker Compose), used for
  local development. Production runs on Supabase Cloud instead (see
  [`CLAUDE.md`](CLAUDE.md#deployment)).

See each component's README for setup and operational instructions, and its `CLAUDE.md` for
architecture details.
