import { useEffect, useState, type KeyboardEvent } from "react";
import type { CustomCell } from "@glideapps/glide-data-grid";
import { editorAction, formatMoney, parseDate, parseMoney, parsePercent } from "./editors.js";

export interface EditorHost {
  searchDimensionValues?: (dimensionKey: string, query: string) => Promise<readonly string[]>;
  searchTags?: (query: string) => Promise<readonly string[]>;
}

let host: EditorHost = {};

export function bindEditorHost(next: EditorHost): void {
  host = next;
}

interface EditableData {
  value: string | null;
  display: string;
}

type ValueCell = CustomCell<EditableData> & { accessibilityString: string };

interface EditorProps<T extends ValueCell> {
  readonly onChange: (newValue: T) => void;
  readonly onFinishedEditing: (newValue?: T, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void;
  readonly value: T;
  readonly initialValue?: string;
}

function applyText<T extends ValueCell>(cell: T, value: string, display: string): T {
  return {
    ...cell,
    copyData: value,
    data: { ...cell.data, value, display },
  };
}

function onEditorKey<T extends ValueCell>(
  event: KeyboardEvent<HTMLInputElement>,
  text: string,
  parse: (input: string) => string | null,
  display: (value: string) => string,
  props: EditorProps<T>,
): void {
  const action = editorAction(event.key, event.shiftKey);
  if (action.type === "type") return;
  event.preventDefault();
  if (action.type === "cancel") {
    props.onFinishedEditing(undefined);
    return;
  }
  const parsed = parse(text);
  if (parsed === null) {
    props.onFinishedEditing(undefined);
    return;
  }
  const next = applyText(props.value, parsed, display(parsed));
  if (action.type === "commit") {
    props.onFinishedEditing(next);
    return;
  }
  props.onFinishedEditing(next, action.movement);
}

export function MoneyEditor<T extends ValueCell>(props: EditorProps<T> & { currency: string }) {
  const [text, setText] = useState(props.initialValue ?? props.value.data.value ?? "");
  return (
    <input
      autoFocus
      value={text}
      aria-label={props.value.accessibilityString}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseMoney(next);
        if (parsed !== null) props.onChange(applyText(props.value, parsed, formatMoney(parsed, props.currency)));
      }}
      onKeyDown={(event) => onEditorKey(event, text, parseMoney, (value) => formatMoney(value, props.currency), props)}
    />
  );
}

export function PercentEditor<T extends ValueCell>(props: EditorProps<T>) {
  const [text, setText] = useState(props.initialValue ?? props.value.data.value ?? "");
  return (
    <input
      autoFocus
      value={text}
      aria-label={props.value.accessibilityString}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parsePercent(next);
        if (parsed !== null) props.onChange(applyText(props.value, parsed, `${parsed}%`));
      }}
      onKeyDown={(event) => onEditorKey(event, text, parsePercent, (value) => `${value}%`, props)}
    />
  );
}

export function DateEditor<T extends ValueCell>(props: EditorProps<T>) {
  const [text, setText] = useState(props.initialValue ?? props.value.data.value ?? "");
  return (
    <input
      autoFocus
      value={text}
      aria-label={props.value.accessibilityString}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseDate(next);
        if (parsed !== null) props.onChange(applyText(props.value, parsed, parsed));
      }}
      onKeyDown={(event) => onEditorKey(event, text, parseDate, (value) => value, props)}
    />
  );
}

export function TextEditor<T extends ValueCell>(props: EditorProps<T>) {
  const [text, setText] = useState(props.initialValue ?? props.value.data.value ?? "");
  return (
    <input
      autoFocus
      value={text}
      aria-label={props.value.accessibilityString}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        props.onChange(applyText(props.value, next, next));
      }}
      onKeyDown={(event) => onEditorKey(event, text, (value) => value, (value) => value, props)}
    />
  );
}

function ChoiceList<T extends ValueCell>({
  props,
  text,
  setText,
  choices,
  onChoose,
}: {
  props: EditorProps<T>;
  text: string;
  setText: (value: string) => void;
  choices: readonly string[];
  onChoose: (value: string) => void;
}) {
  return (
    <div>
      <input
        autoFocus
        value={text}
        aria-label={props.value.accessibilityString}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => onEditorKey(event, text, (value) => value, (value) => value, props)}
      />
      <ul>
        {choices.map((choice) => (
          <li key={choice}>
            <button type="button" onClick={() => onChoose(choice)}>
              {choice}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DimensionPicker<T extends ValueCell>(props: EditorProps<T> & { dimensionKey: string }) {
  const [text, setText] = useState(props.initialValue ?? props.value.data.value ?? "");
  const [choices, setChoices] = useState<readonly string[]>([]);
  const dimensionKey = props.dimensionKey;
  useEffect(() => {
    let cancelled = false;
    const search = host.searchDimensionValues;
    void (search === undefined ? Promise.resolve([]) : search(dimensionKey, text)).then((values) => {
      if (!cancelled) setChoices(values);
    });
    return () => {
      cancelled = true;
    };
  }, [dimensionKey, text]);
  return (
    <ChoiceList
      props={props}
      text={text}
      setText={setText}
      choices={choices}
      onChoose={(value) => props.onFinishedEditing(applyText(props.value, value, value))}
    />
  );
}

export function TagPicker<T extends ValueCell>(props: EditorProps<T>) {
  const [text, setText] = useState(props.initialValue ?? props.value.data.value ?? "");
  const [choices, setChoices] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const search = host.searchTags;
    void (search === undefined ? Promise.resolve([]) : search(text)).then((values) => {
      if (!cancelled) setChoices(values);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return (
    <ChoiceList
      props={props}
      text={text}
      setText={setText}
      choices={choices}
      onChoose={(value) => props.onFinishedEditing(applyText(props.value, value, value))}
    />
  );
}
