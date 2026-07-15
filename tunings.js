export const CATEGORIES = [
  { id: "chromatic", label: "クロマチック" },
  { id: "standard", label: "標準" },
  { id: "drop", label: "ドロップ系" },
  { id: "open", label: "オープン系" },
  { id: "transpose", label: "全体移調" },
  { id: "special", label: "特殊" },
];

export const TUNINGS = [
  { id: "chromatic", name: "クロマチック", cat: "chromatic", notes: null },

  { id: "standard", name: "レギュラー", cat: "standard", notes: ["E2", "A2", "D3", "G3", "B3", "E4"] },

  { id: "dropD", name: "ドロップD", cat: "drop", notes: ["D2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "doubleDropD", name: "ダブルドロップD", cat: "drop", notes: ["D2", "A2", "D3", "G3", "B3", "D4"] },
  { id: "dadgad", name: "DADGAD", cat: "drop", notes: ["D2", "A2", "D3", "G3", "A3", "D4"] },
  { id: "dropCs", name: "ドロップC#", cat: "drop", notes: ["C#2", "G#2", "C#3", "F#3", "A#3", "D#4"] },
  { id: "dropC", name: "ドロップC", cat: "drop", notes: ["C2", "G2", "C3", "F3", "A3", "D4"] },
  { id: "dropB", name: "ドロップB", cat: "drop", notes: ["B1", "F#2", "B2", "E3", "G#3", "C#4"] },
  { id: "dropA", name: "ドロップA", cat: "drop", notes: ["A1", "E2", "A2", "D3", "F#3", "B3"] },
  { id: "gModal", name: "Gモーダル", cat: "drop", notes: ["D2", "G2", "D3", "G3", "C4", "D4"] },

  { id: "openC", name: "オープンC", cat: "open", notes: ["C2", "G2", "C3", "G3", "C4", "E4"] },
  { id: "openE", name: "オープンE", cat: "open", notes: ["E2", "B2", "E3", "G#3", "B3", "E4"] },
  { id: "openF", name: "オープンF", cat: "open", notes: ["C2", "F2", "C3", "F3", "A3", "F4"] },
  { id: "openG", name: "オープンG", cat: "open", notes: ["D2", "G2", "D3", "G3", "B3", "D4"] },
  { id: "openA", name: "オープンA", cat: "open", notes: ["E2", "A2", "C#3", "E3", "A3", "E4"] },
  { id: "openA2", name: "オープンA 2", cat: "open", notes: ["E2", "A2", "E3", "A3", "C#4", "E4"] },
  { id: "openAm", name: "オープンAm", cat: "open", notes: ["E2", "A2", "E3", "A3", "C4", "E4"] },
  { id: "openEm", name: "オープンEm", cat: "open", notes: ["E2", "B2", "E3", "G3", "B3", "E4"] },
  { id: "openD", name: "オープンD", cat: "open", notes: ["D2", "A2", "D3", "F#3", "A3", "D4"] },
  { id: "openDm", name: "オープンDm", cat: "open", notes: ["D2", "A2", "D3", "F3", "A3", "D4"] },

  { id: "halfDown", name: "半音下げ", cat: "transpose", notes: ["D#2", "G#2", "C#3", "F#3", "A#3", "D#4"] },
  { id: "wholeDown", name: "全音下げ", cat: "transpose", notes: ["D2", "G2", "C3", "F3", "A3", "D4"] },
  { id: "halfUp", name: "半音上げ", cat: "transpose", notes: ["F2", "A#2", "D#3", "G#3", "C4", "F4"] },
  { id: "wholeUp", name: "全音上げ", cat: "transpose", notes: ["F#2", "B2", "E3", "A3", "C#4", "F#4"] },

  { id: "doubleDaddy", name: "ダブルダディ", cat: "special", notes: ["D2", "A2", "D3", "D3", "A3", "D4"] },
  { id: "all4th", name: "オール4th", cat: "special", notes: ["E2", "A2", "D3", "G3", "C4", "F4"] },
  { id: "nst", name: "NST", cat: "special", notes: ["C2", "G2", "D3", "A3", "E4", "G4"] },
  { id: "ostrich", name: "オストリッチ", cat: "special", notes: ["D2", "D3", "D3", "D4", "D4", "D4"] },
];
