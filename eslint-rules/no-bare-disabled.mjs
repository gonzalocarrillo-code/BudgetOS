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
        const native = node.name.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name);
        if (native && attrs.some((a) => a.name.name === "title")) return;
        // A spread may carry `reason` (e.g. {...(why ? { disabled: true, reason: why } : {})}); only flag what we can see.
        context.report({ node: disabled, messageId: "bare" });
      },
    };
  },
};

export default { rules: { "no-bare-disabled": rule } };
