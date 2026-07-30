# Credits

## Guitar reference-tone samples

The recorded acoustic-guitar notes played when a string's note letter is tapped
(`samples/guitar/*.mp3`) are from the **University of Iowa Electronic Music
Studios – Musical Instrument Samples (MIS)**, which have been made freely
available without restriction on their use since 1997.

- Source: <https://theremin.music.uiowa.edu/MISguitar.html>
- Packaged per-note (via <https://github.com/nbrosowsky/tonejs-instruments>)
- Processed here: trimmed to ~2.8 s, leading silence removed, tail faded, and
  re-encoded to mono 96 kbps MP3.

With thanks to the University of Iowa for providing these recordings freely.

## Pitch-detection library

`pitchy.js` is a bundled copy of **pitchy** v4.1.0 by Ian Johnson
(<https://github.com/ianprime0509/pitchy>), obtained via esm.sh. The NSDF
normalisation in `pitch-processing.js` is also derived from it.

> Copyright Ian Johnson
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
> SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
> ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
> IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The pitchy bundle includes **fft.js** by Fedor Indutny
(<https://github.com/indutny/fft.js>), MIT License:

> Copyright Fedor Indutny, 2017.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to
> deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
> sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
> FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.

## Test fixture

`tests/fixtures/fasttune-e2-82hz.wav` is from the FastTune project (MIT);
see `tests/fixtures/README.md` for the full notice.
