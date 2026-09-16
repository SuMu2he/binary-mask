'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { evaluateNumericExpression } from './numeric-expression';

type NumericInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'type' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: number;
  onValueChange: (value: number) => void;
  suffix?: string;
};

const invalidMessage = '请输入有效的数字或四则运算公式，除数不能为 0。';

export function validateNumericInputs(scope: HTMLElement | null): boolean {
  const inputs = scope?.querySelectorAll<HTMLInputElement>('input[data-numeric-input]:not(:disabled)');
  for (const input of inputs ?? []) {
    if (!input.checkValidity()) {
      input.focus();
      input.reportValidity();
      return false;
    }
  }
  return true;
}

export default function NumericInput({ value, onValueChange, suffix = '', min, max, step = 1, ...props }: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const parse = (text: string) => evaluateNumericExpression(suffix && text.trimEnd().endsWith(suffix) ? text.trimEnd().slice(0, -suffix.length) : text);
  const normalize = (next: number) => Math.max(min === undefined ? -Infinity : Number(min), Math.min(max === undefined ? Infinity : Number(max), next));
  const update = (text: string, input: HTMLInputElement, commit: boolean) => {
    const result = parse(text);
    input.setCustomValidity(result === null ? invalidMessage : '');
    setInvalid(result === null);
    setDraft(result !== null && commit ? null : text);
    if (result !== null) onValueChange(normalize(result));
    return result !== null;
  };

  return <input {...props} type="text" data-numeric-input="" value={draft ?? `${value}${suffix}`} aria-invalid={invalid || undefined}
    title={invalid ? invalidMessage : (props.title ?? '支持 +、-、*、/ 和括号；回车或离开输入框后显示结果。')}
    spellCheck={false} autoComplete="off" maxLength={256}
    onChange={(event) => update(event.target.value, event.currentTarget, false)}
    onBlur={(event) => { update(event.currentTarget.value, event.currentTarget, true); }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        if (update(event.currentTarget.value, event.currentTarget, true)) event.currentTarget.blur();
        else event.currentTarget.reportValidity();
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setCustomValidity(''); setInvalid(false); setDraft(null);
        event.currentTarget.value = `${value}${suffix}`; event.currentTarget.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const increment = step === 'any' ? 1 : Number(step);
        const next = normalize((parse(event.currentTarget.value) ?? value) + (event.key === 'ArrowUp' ? increment : -increment));
        update(String(Number(next.toPrecision(12))), event.currentTarget, true);
      }
    }} />;
}
