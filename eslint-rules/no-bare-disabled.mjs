// budget/no-bare-disabled (spec §27, AGENTS.md §4): every disabled control says why. A JSX element
// with a `disabled` attribute must also have `reason` (`<Button disabled reason="…">`, which renders
// the tooltip); a native element (<select>, <input>, <button>) states it in `title`, its tooltip.
// `disabled={false}` is fine.
/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "A disabled control must state why (`reason`)" },
    messages: { bare: "`disabled` needs a `reason` that tells the user why and what would enable it (<Button disabled reason=\"…\">)." },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const attrs = node.attributes.filter((a) => a.type === "JSXAttribute");
        const disabled = attrs.find((a) => a.name.name === "disabled");
        if (!disabled) return;
        const v = disabled.value;
        const literalFalse = v && v.type === "JSXExpressionContainer" && v.expression.type === "Literal" && v.expression.value === false;
        if (literalFalse) return;
        if (attrs.some((a) => a.name.name === "reason")) return;
        // Native fields and the @budget/ui fields that render one (DS-001) state it in `title`.
        const native = node.name.type === "JSXIdentifier" && (/^[a-z]/.test(node.name.name) || ["Input", "NumberInput", "Select", "Textarea"].includes(node.name.name));
        if (native && attrs.some((a) => a.name.name === "title")) return;
        // A spread may carry `reason` (e.g. {...(why ? { disabled: true, reason: why } : {})}); only flag what we can see.
        context.report({ node: disabled, messageId: "bare" });
      },
    };
  },
};

// budget/no-raw-form-controls (DS-001, docs/UX_AUDIT_AND_ADMIN_PLAN.md §2.3): a styled native
// <input>, <select> or <textarea> outside @budget/ui is a hand-rolled control. Use Input, Select,
// Textarea, NumberInput or FormField from @budget/ui so every field looks and behaves the same.
// Checkboxes, radios, file and hidden inputs are left alone. Reported as a warning while the
// screens migrate.
/** @type {import("eslint").Rule.RuleModule} */
const rawControls = {
  meta: {
    type: "suggestion",
    docs: { description: "Use the @budget/ui form controls, not styled native fields" },
    messages: { raw: "Use <{{component}}> from @budget/ui instead of a styled <{{tag}}> (DS-001)." },
    schema: [],
  },
  create(context) {
    if (context.filename.includes("/packages/ui/")) return {};
    const COMPONENT = { input: "Input", select: "Select", textarea: "Textarea" };
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !(node.name.name in COMPONENT)) return;
        const attrs = node.attributes.filter((a) => a.type === "JSXAttribute");
        if (!attrs.some((a) => a.name.name === "className")) return;
        const type = attrs.find((a) => a.name.name === "type");
        const kind = type && type.value && type.value.type === "Literal" ? String(type.value.value) : "text";
        if (node.name.name === "input" && ["checkbox", "radio", "file", "hidden", "range", "color"].includes(kind)) return;
        context.report({ node, messageId: "raw", data: { tag: node.name.name, component: COMPONENT[node.name.name] } });
      },
    };
  },
};

export default { rules: { "no-bare-disabled": rule, "no-raw-form-controls": rawControls } };
