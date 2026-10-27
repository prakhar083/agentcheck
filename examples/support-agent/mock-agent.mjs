// A deterministic stand-in for an LLM, so the example suite runs offline.
//
// It implements agentcheck's provider interface:
//   complete(request) -> { text, toolCalls, stopReason, usage }
// and behaves like a small, rule-following support agent. Swap the suite's
// provider for `type: anthropic` to evaluate a real model with the same file.

/** @typedef {{ role: "user", content: string } | { role: "assistant", text: string, toolCalls: { id: string, name: string, args: Record<string, unknown> }[] } | { role: "tool", results: { callId: string, name: string, content: string, isError: boolean }[] }} Message */

let callCounter = 0;
let refundStatusAnswers = 0;

export default function createMockAgent() {
  return {
    name: "mock-support-agent",
    async complete(request) {
      // Simulated network + generation latency, deterministic per request size.
      await sleep(40 + (JSON.stringify(request.messages).length % 60));
      const reply = request.responseSchema ? judge(request) : agent(request);
      const toolCalls = (reply.toolCalls ?? []).map((c, i) => ({ id: `toolu_${++callCounter}_${i}`, ...c }));
      return {
        text: reply.text ?? "",
        toolCalls,
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage: estimateUsage(request, reply.text ?? "", toolCalls),
      };
    },
  };
}

/** @param {{ system?: string, messages: Message[] }} request */
function agent(request) {
  const { messages } = request;
  const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content);
  const latestUser = userTexts.at(-1) ?? "";
  const orderId = userTexts.join(" ").match(/\b([A-Z]\d{4})\b/)?.[1];
  const results = messages.filter((m) => m.role === "tool").flatMap((m) => m.results);
  const lookup = results.find((r) => r.name === "lookup_order");
  const refund = results.find((r) => r.name === "issue_refund");
  const escalation = results.find((r) => r.name === "escalate_to_human");

  // Follow-up questions answered from conversation history.
  if (/status of my refund/i.test(latestUser)) {
    const history = messages.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
    const refundId = history.match(/R-\d+/)?.[0];
    refundStatusAnswers++;
    return refundStatusAnswers % 4 === 0
      ? { text: "Your refund has been approved and is on its way back to your card." }
      : { text: `Refund ${refundId} is approved; expect it on your card within 5 business days.` };
  }

  if (!orderId) return { text: "Happy to help. Could you share your order number?" };
  if (!lookup) return { toolCalls: [{ name: "lookup_order", args: { order_id: orderId } }] };
  if (lookup.isError) {
    return { text: `I couldn't find order ${orderId}. Could you double-check the order number?` };
  }

  const order = JSON.parse(lookup.content);

  if (/json/i.test(request.system ?? "")) {
    return { text: JSON.stringify({ order_id: order.order_id, status: order.status, total: order.total }) };
  }

  const wantsRefund = /refund|return|damaged|torn|broken/i.test(latestUser);
  if (!wantsRefund) {
    if (order.status === "in_transit") {
      return { text: `Your order ${order.order_id} is in transit and should arrive by ${order.eta}.` };
    }
    return { text: `Your order ${order.order_id} is ${order.status.replace("_", " ")}.` };
  }

  if (escalation) {
    const ticket = JSON.parse(escalation.content).ticket;
    return {
      text: `I'm sorry about the damage. Because of the order value I've passed this to a specialist (ticket ${ticket}); they'll contact you within one business day.`,
    };
  }
  if (refund) {
    if (refund.isError) return { text: "I'm sorry, the refund couldn't be processed. I've flagged it for the team." };
    const { refund_id } = JSON.parse(refund.content);
    return {
      text: `I'm sorry your item arrived damaged. I've issued a full refund of $${order.total.toFixed(2)} (refund ID ${refund_id}); it should reach your card within 5 business days.`,
    };
  }
  if (order.status !== "delivered") {
    return { text: `Order ${order.order_id} hasn't been delivered yet, so it can't be refunded. It should arrive by ${order.eta}.` };
  }
  if (order.days_since_delivery > 30) {
    return {
      text: `I'm sorry, but order ${order.order_id} was delivered ${order.days_since_delivery} days ago, and refunds are only available within 30 days of delivery.`,
    };
  }
  if (order.total > 500) {
    return {
      toolCalls: [
        {
          name: "escalate_to_human",
          args: { order_id: order.order_id, summary: `Customer reports damage on a $${order.total} order.` },
        },
      ],
    };
  }
  return {
    toolCalls: [{ name: "issue_refund", args: { order_id: order.order_id, amount: order.total, reason: "damaged item" } }],
  };
}

/**
 * Offline judge: rewards answers that are polite and grounded in tool output.
 * A real judge model reads the rubric; this one only approximates it.
 */
function judge(request) {
  const prompt = request.messages[0]?.content ?? "";
  const answer = prompt.match(/<final_answer>\n([\s\S]*?)\n<\/final_answer>/)?.[1] ?? "";
  const polite = /sorry|thanks|happy to/i.test(answer);
  const grounded = /\$\d|R-\d+|T-\d+|\d+ days/.test(answer);
  const score = 3 + (polite ? 1 : 0) + (grounded ? 1 : 0);
  const reasoning = [
    polite ? "Tone is polite and acknowledges the customer." : "Tone is curt; no acknowledgement of the customer's problem.",
    grounded ? "The answer cites concrete details from the tool results." : "The answer lacks concrete details from the tool results.",
  ].join(" ");
  return { text: JSON.stringify({ reasoning, score }) };
}

function estimateUsage(request, text, toolCalls) {
  const promptChars = (request.system ?? "").length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
  return {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
