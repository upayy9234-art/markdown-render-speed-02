# markdown-render-speed-02

Renderer CommonMark 0.31.2 + GFM yang cepat. `parse(markdown)` mengembalikan
persis HTML yang dirender marked 18.1.3 dengan opsi default-nya (gfm aktif,
breaks mati, pedantic mati) — dan me-render-nya lebih cepat.

## Tata letak

- `parse.js` — renderer-nya. Modul ES tanpa dependensi; `parse(markdown)`
  mengembalikan string HTML untuk satu dokumen.
- `main.ts` — driver yang dijalankan harness: membaca `/input/cases.json`,
  me-render tiap case sendiri-sendiri dengan `parse`, lalu menulis string
  HTML-nya, berurutan, ke `/output/html.json`.

## Cara kerja

Grammar blok dan inline mengikuti bentuk yang dipakai marked (bentuk itulah
yang mengodekan perilaku persisnya, termasuk di mana marked menyimpang dari
spesifikasi), sementara jalur panas — pemindaian teks inline, escaping HTML,
dan dekode referensi numerik — berupa pemindaian karakter tulisan tangan,
bukan regular expression. Rendering bekerja langsung pada token, tanpa
salinan sumber yang tidak perlu.

Target perilaku: marked 18.1.3 (MIT), github.com/markedjs/marked pada tag
v18.1.3.

## Cara run

```sh
node main.ts
```

Dengan `MAKEFUN_INPUT_DIR` dan `MAKEFUN_OUTPUT_DIR` untuk mengarahkan
direktori masukan/keluaran di luar container harness.

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/upayy9234-art/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/upayy9234-art/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
