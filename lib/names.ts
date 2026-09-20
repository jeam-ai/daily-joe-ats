// Keep HR-entered mixed case and compound surnames intact. Only reorder when
// a comma or an explicit source order identifies the surname unambiguously.
export function formalName(value: string, surnameFirst = false) {
  let name = value.trim().replace(/\s+/g, " ");
  if (/requires review|not stated|not verified/i.test(name)) return name;
  if (name.includes(",")) {
    const [last, ...given] = name.split(",");
    name = `${given.join(" ").trim()} ${last.trim()}`;
  } else if (surnameFirst) {
    const [last, ...given] = name.split(" ");
    name = `${given.join(" ")} ${last}`;
  }
  return name
    .split(" ")
    .map((word) => {
      if (/^(?:[A-Za-z]\.)+$/.test(word) || /^(?:II|III|IV|VI)$/i.test(word))
        return word.toUpperCase();
      if (word !== word.toUpperCase() && word !== word.toLowerCase())
        return word;
      return word
        .toLowerCase()
        .replace(/(^|[-'’])\p{L}/gu, (s) => s.toUpperCase())
        .replace(/^Mc\p{L}/u, (s) => s.slice(0, 2) + s.slice(2).toUpperCase());
    })
    .join(" ");
}
export function nameParts(name: string) {
  const words = formalName(name).split(" ");
  let surname = words.length - 1;
  if (surname > 1 && /^(?:Jr\.?|Sr\.?|II|III|IV|VI)$/i.test(words[surname]))
    surname--;
  while (
    surname > 1 &&
    /^(?:de|del|dela|la|las|los|van|von|san|santa|da|dos)$/i.test(
      words[surname - 1],
    )
  )
    surname--;
  return {
    firstName: words[0] || "",
    middleName: words.slice(1, surname).join(" "),
    lastName: words.length > 1 ? words.slice(surname).join(" ") : "",
  };
}
