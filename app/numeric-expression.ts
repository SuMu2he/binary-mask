/** Parse arithmetic only; never execute input as JavaScript. */
export function evaluateNumericExpression(input: string): number | null {
  if (input.length > 256) return null;
  const source = input.trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  let position = 0;
  let depth = 0;
  const spaces = () => { while (/\s/.test(source[position] ?? '') && position < source.length) position += 1; };
  const finite = (value: number) => { if (!Number.isFinite(value)) throw new Error('Non-finite result'); return value; };
  const primary = (): number => {
    spaces();
    if (++depth > 32) throw new Error('Expression too deeply nested');
    let value: number;
    const symbol = source[position];
    if (symbol === '+' || symbol === '-') {
      position += 1;
      value = primary() * (symbol === '-' ? -1 : 1);
    } else if (symbol === '(') {
      position += 1;
      value = expression();
      spaces();
      if (source[position++] !== ')') throw new Error('Missing closing parenthesis');
    } else {
      const match = source.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error('Expected a number');
      position += match[0].length;
      value = Number(match[0]);
    }
    depth -= 1;
    return finite(value);
  };
  const product = (): number => {
    let value = primary();
    spaces();
    while (source[position] === '*' || source[position] === '/') {
      const operator = source[position++];
      const right = primary();
      if (operator === '/' && right === 0) throw new Error('Division by zero');
      value = finite(operator === '*' ? value * right : value / right);
      spaces();
    }
    return value;
  };
  const expression = (): number => {
    let value = product();
    spaces();
    while (source[position] === '+' || source[position] === '-') {
      const operator = source[position++];
      const right = product();
      value = finite(operator === '+' ? value + right : value - right);
      spaces();
    }
    return value;
  };
  try {
    const value = expression();
    spaces();
    return position === source.length ? value : null;
  } catch {
    return null;
  }
}
