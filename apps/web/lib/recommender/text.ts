/**
 * Text -> features for the problem recommender.
 *
 * Statements are Codeforces-style markdown with LaTeX (`$a_i \le 10^9$`) and boilerplate ("The first line of the
 * input contains..."). Features are lower-cased, lightly stemmed unigrams and bigrams after stripping math, code,
 * links and boilerplate stop-words, so what remains is topical vocabulary ("palindrome", "parity", "modulo").
 */

/** Recurring Codeforces protagonists: story characters, not topics, and they would create spurious similarity. */
const NAME_WORDS = 'vasya petya polycarp monocarp alice bob vova vasily vanya anton dima sasha misha masha kolya tanya pasha nikita arkady ivan igor maxim andrey sergey gleb valera mike peter john kate lena ann tom'.split(' ');
const STOPWORDS = new Set(
  (
    // common English
    'a an the and or but if then else of to in on at by for from with without into onto over under about as is are was were be been being ' +
    'it its this that these those there here which who whom whose what when where why how not no nor so than too very can could should would ' +
    'will shall may might must do does did done have has had having you your yours we our ours they their them he she his her i me my ' +
    'also only just any all each every both either neither some such other another more most less least much many few one two three four five ' +
    'first second third last next previous given following above below between among during before after again further once ' +
    // Codeforces statement boilerplate
    'input output test tests case cases line lines contain contains containing contained single integer integers number numbers print prints ' +
    'printed example examples note notes follow follows followed consist consists consisting space spaces separated denote denotes denoted ' +
    'define defined describe describes described problem problems statement statements guaranteed guarantee guarantees allowed possible ' +
    'find finds found print output display tell say determine answer answers value values per query queries'
  ).split(/\s+/).concat(NAME_WORDS),
);

/** Remove math, code, links and markdown punctuation, keeping the prose. */
export function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_`>|~\[\]{}()]/g, ' ');
}

/** A deliberately tiny stemmer (plural / -ing / -ed) - enough to merge "palindromes" with "palindrome". */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  // Only strip a suffix when a real stem (>= 4 letters) remains: "sorting" -> "sort", but "string" stays "string".
  if (word.endsWith('ing') && word.length - 3 >= 4) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length - 2 >= 4) return word.slice(0, -2);
  return word;
}

/** Stemmed content tokens in order, with stop-words removed. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of stripMarkup(text).toLowerCase().matchAll(/[a-z][a-z0-9]+/g)) {
    const word = match[0];
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    tokens.push(stem(word));
  }
  return tokens;
}

/**
 * Raw feature counts for one problem: unigrams and adjacent-token bigrams (`foo_bar`).
 * Title tokens count double - the title is the most concentrated statement of the topic.
 */
export function extractFeatures(title: string, body: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (feature: string, weight: number) => counts.set(feature, (counts.get(feature) ?? 0) + weight);
  const titleTokens = tokenize(title);
  const bodyTokens = tokenize(body);
  for (const token of titleTokens) add(token, 2);
  for (const token of bodyTokens) add(token, 1);
  for (const tokens of [titleTokens, bodyTokens]) {
    for (let i = 0; i + 1 < tokens.length; i++) add(`${tokens[i]}_${tokens[i + 1]}`, 1);
  }
  return counts;
}
