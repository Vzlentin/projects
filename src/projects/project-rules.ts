/**
 * The rules of the project, in the project store. An agent adds and changes an open rule, the user changes a rule in
 * any status, and the source of a rule is a message of a thread or the exact words of the user. A delete of a message
 * fails while a rule that is not retired has it as its source, and removes it as the source of a retired rule.
 */
import type { Rule, RuleSet, RuleUserChange } from "../protocol/project.ts";
import { knownAuthor, type StoreTx } from "./project-store.ts";

/**
 * Adds or changes a rule of an agent for the caller `by`, and gives it. A rule with a source message is `open`, and gets
 * the thread of that message. A rule with the exact words of the user is decided at once, as a decide of the user makes
 * it. A new rule can name with `replaces` the rule that it replaces, which the decide of the new rule retires. Only an
 * open rule changes.
 */
export function setRule(tx: StoreTx, change: RuleSet, by: string): Rule {
	if (change.id !== undefined && change.replaces !== undefined) {
		throw new Error("A change of a rule cannot replace a rule: set replaces on a new rule");
	}

	const said =
		change.words === undefined
			? { saidBy: change.saidBy, source: change.source, thread: tx.message(change.source).thread }
			: { saidBy: change.saidBy, words: change.words };

	knownAuthor(tx, said.saidBy);
	const at = Date.now();
	let rule: Rule;

	if (change.id === undefined) {
		const added: Omit<Rule, "id"> = {
			name: change.name,
			kind: change.kind,
			value: change.value,
			status: "open",
			...said,
			at,
			by,
		};

		if (change.replaces !== undefined) added.replaces = tx.rule(change.replaces).id;
		rule = tx.addRule(added);
	} else {
		rule = tx.rule(change.id);
		mustBeOpen(rule);
		setRuleText(rule, change);
		delete rule.source;
		delete rule.thread;
		delete rule.words;
		Object.assign(rule, { ...said, at, by });
		tx.putRule(rule);
	}

	if (said.words !== undefined) decideRule(tx, rule, at, by);

	return rule;
}

/**
 * Puts the open rule `rule` in effect at `at` for the caller `by`, and retires the rule that it replaces when that rule
 * is there and not retired.
 */
function decideRule(tx: StoreTx, rule: Rule, at: number, by: string): void {
	mustBeOpen(rule);
	const replaced = rule.replaces === undefined ? undefined : tx.findRule(rule.replaces);

	if (replaced !== undefined && replaced.status !== "retired") tx.putRule({ ...replaced, status: "retired", at, by });
	Object.assign(rule, { status: "decided", at, by });
	tx.putRule(rule);
}

/** Fails when `rule` is not open. */
function mustBeOpen(rule: Rule): void {
	if (rule.status !== "open") throw new Error(`Rule ${rule.id} is ${rule.status}, not open`);
}

/** Sets on `rule` the name, the kind and the value of `text` that are given. */
function setRuleText(rule: Rule, text: Partial<Pick<Rule, "name" | "kind" | "value">>): void {
	if (text.name !== undefined) rule.name = text.name;

	if (text.kind !== undefined) rule.kind = text.kind;

	if (text.value !== undefined) rule.value = text.value;
}

/**
 * Makes the change `change` of the user for the caller `by`, and gives the rule. A decide puts an open rule in effect,
 * and retires the rule that it replaces when that rule is there and not retired. A retire ends an open or a decided
 * rule. An edit changes the text of a rule in any status, and makes the user its author with no source, no
 * thread and no words. A create adds a decided rule of the user. A delete removes the rule; its ID is never given again.
 */
export function changeRule(tx: StoreTx, change: RuleUserChange, by: string): Rule {
	const at = Date.now();

	if (change.action === "create") {
		const { name, kind, value } = change;

		return tx.addRule({ name, kind, value, status: "decided", saidBy: "user", at, by });
	}

	const rule = tx.rule(change.id);

	switch (change.action) {
		case "decide":
			decideRule(tx, rule, at, by);

			return rule;

		case "retire":
			if (rule.status === "retired") throw new Error(`Rule ${rule.id} is retired`);
			Object.assign(rule, { status: "retired", at, by });
			tx.putRule(rule);

			return rule;
		case "edit":
			setRuleText(rule, change);
			Object.assign(rule, { saidBy: "user", at, by });
			delete rule.source;
			delete rule.thread;
			delete rule.words;
			tx.putRule(rule);

			return rule;
		case "delete":
			tx.removeRule(rule.id);

			return rule;
	}
}

/**
 * Lets a delete remove the message `id`: a rule that is not retired and has it as its source fails the delete, and a
 * retired rule with it as its source loses its source and its thread.
 */
export function releaseSource(tx: StoreTx, id: number): void {
	const named = tx.rulesWithSource(id);
	const live = named.find((rule) => rule.status !== "retired");

	if (live !== undefined) throw new Error(`Message ${id} is the source of rule ${live.id}`);

	for (const { source: _, thread: __, ...rule } of named) tx.putRule(rule);
}
