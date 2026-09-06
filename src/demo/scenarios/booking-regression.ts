import type { IngestTraceInput } from '../../models/types.js';

/**
 * Scenario 6: The Same Booking, After a Model Upgrade (COMPLETED)
 *
 * The sibling of scenario 4, and the reason it exists: same agent, same
 * request, a later run on a newer model. Nothing crashes — every step has the
 * same name and type, the trace still ends `completed`, and the user still
 * gets a booking. What changed is the SEARCH QUERY the model wrote and the
 * flight it then chose: a cheaper itinerary with a stop, for a user whose
 * stated preference is nonstop.
 *
 * This is the "it worked Monday, broke Tuesday" case the tool is for, and
 * until this scenario existed the demo could not show it: five traces from
 * five different agents, so `diff <id-a> <id-b>` — which `demo` itself tells
 * you to run next — compared two unrelated runs, and `check --golden` could
 * never report a regression because every baseline had exactly one candidate
 * that matched it trivially.
 *
 * Deliberately a SILENT regression: step count, step names, step types and
 * the final status are identical to scenario 4, so the default structural
 * fields all pass. It is `--fields tool_inputs` (the rewritten query),
 * `decisions` (the option chosen) and `model` that catch it — exactly the
 * three the README says a structural gate is blind to.
 *
 * 10 steps, ~3.6k tokens, 3.1s.
 */
export function bookingRegression(baseTime: Date): IngestTraceInput {
  const t = (offsetMs: number) => new Date(baseTime.getTime() - offsetMs).toISOString();

  return {
    agent_name: 'travel-assistant',
    agent_version: '4.3.0',
    trigger: 'user_message',
    status: 'completed',
    // Byte-identical to scenario 4's input: that is what makes the two runs a
    // matched pair for `check --golden`, which keys on agent name and input.
    input: {
      user_message: 'Book me a flight from SFO to JFK next Friday, economy class',
      user_id: 'usr_7823',
      preferences: { airline: 'any', stops: 'nonstop_preferred' },
    },
    output: {
      booking_confirmation: {
        pnr: 'XYZ789',
        flight: 'B6 212',
        departure: 'SFO 14:00',
        arrival: 'JFK 22:30',
        class: 'economy',
        price_usd: 299.0,
        stops: 1,
      },
      message: 'Your flight has been booked! Confirmation: XYZ789, B6 212 SFO→JFK departing 14:00.',
    },
    started_at: t(300_000), // 5 min ago — the newer of the pair
    ended_at: t(300_000 - 3_100),
    total_duration_ms: 3100,
    total_tokens: 3600,
    total_cost_usd: 0.019,
    error: null,
    tags: ['travel', 'booking', 'regression'],
    session_id: 'sess_demo_travel_02',
    metadata: { environment: 'production', channel: 'mobile_app', model_rollout: 'gpt-4.1' },
    steps: [
      {
        step_number: 1,
        step_type: 'thought',
        name: 'parse_booking_intent',
        input: { user_message: 'Book me a flight from SFO to JFK next Friday, economy class' },
        output: {
          intent: 'flight_booking',
          params: { origin: 'SFO', destination: 'JFK', date: 'next_friday', class: 'economy' },
        },
        started_at: t(300_000),
        duration_ms: 110,
        tokens_used: 400,
        metadata: {},
      },
      {
        step_number: 2,
        step_type: 'tool_call',
        name: 'resolve_date',
        input: { relative_date: 'next Friday' },
        output: { resolved_date: '2026-03-06', day_of_week: 'Friday' },
        started_at: t(300_000 - 110),
        duration_ms: 30,
        tokens_used: 50,
        metadata: { tool: 'date_resolver' },
      },
      {
        step_number: 3,
        step_type: 'tool_call',
        name: 'search_flights',
        // The regression starts here: the newer model rewrote the query. Same
        // tool, same step name — only the arguments moved, which is why
        // `--fields tool_inputs` exists.
        input: { origin: 'SFO', destination: 'JFK', date: '2026-03-06', cabin: 'ECONOMY', flexible_dates: true },
        output: {
          flights: [
            { id: 'fl_1', airline: 'United', flight: 'UA 456', depart: '08:30', arrive: '17:05', price: 342.50, stops: 0 },
            { id: 'fl_2', airline: 'Delta', flight: 'DL 890', depart: '10:15', arrive: '19:00', price: 378.00, stops: 0 },
            { id: 'fl_3', airline: 'JetBlue', flight: 'B6 212', depart: '14:00', arrive: '22:30', price: 299.00, stops: 1 },
          ],
          total_results: 3,
        },
        started_at: t(300_000 - 140),
        duration_ms: 470,
        tokens_used: 600,
        metadata: { tool: 'flight_api', provider: 'amadeus' },
        snapshot: {
          context_window: { messages: 3, total_tokens: 1050 },
          environment: { api_calls: 1 },
          tool_state: { flight_api: 'connected', results_cached: true },
          token_count: 1050,
        },
      },
      {
        step_number: 4,
        step_type: 'decision',
        name: 'rank_options',
        input: { flights: 3, user_preference: 'nonstop_preferred' },
        output: {
          recommended: 'fl_3',
          reasoning: 'Lowest total price',
          ranking: ['fl_3', 'fl_1', 'fl_2'],
        },
        started_at: t(300_000 - 610),
        duration_ms: 80,
        tokens_used: 300,
        caused_by_step: 3,
        // The choice itself changed, and nothing structural shows it: same step
        // number, same name, same type. `--fields decisions` is the only default
        // -shaped gate that can see a swapped option.
        decision: {
          options: [
            { option: 'fl_3', rationale: 'JetBlue B6 212 — cheapest at $299.00, one stop', score: 0.88 },
            { option: 'fl_1', rationale: 'United UA 456 — nonstop, $342.50', score: 0.62 },
            { option: 'fl_2', rationale: 'Delta DL 890 — nonstop but $378.00', score: 0.41 },
          ],
          chosen: 'fl_3',
          rationale: 'Cheapest fare available for the date.',
          confidence: 0.55,
          decided_by: 'agent',
        },
        metadata: {},
      },
      {
        step_number: 5,
        step_type: 'llm_call',
        name: 'format_options_message',
        parent_step: 4,
        caused_by_step: 4,
        input: { ranked_flights: ['fl_3', 'fl_1', 'fl_2'], recommended: 'fl_3' },
        output: {
          text: "I found 3 flights for you:\n\n✈ **Recommended:** B6 212 — SFO 14:00→JFK 22:30 — $299.00 (1 stop)\n  UA 456 — SFO 08:30→JFK 17:05 — $342.50 (nonstop)\n  DL 890 — SFO 10:15→JFK 19:00 — $378.00 (nonstop)\n\nShall I book B6 212?",
        },
        started_at: t(300_000 - 690),
        duration_ms: 580,
        tokens_used: 800,
        model: 'gpt-4.1',
        metadata: { temperature: 0.3 },
      },
      {
        step_number: 6,
        step_type: 'output',
        name: 'present_options',
        parent_step: 4,
        input: { message_type: 'flight_options', options_count: 3 },
        output: { delivered: true, message_id: 'msg_9104' },
        started_at: t(300_000 - 1270),
        duration_ms: 40,
        tokens_used: 50,
        metadata: {},
      },
      {
        step_number: 7,
        step_type: 'thought',
        name: 'process_user_confirmation',
        input: { user_response: 'ok', selected_flight: 'fl_3' },
        output: { action: 'proceed_with_booking', flight_id: 'fl_3' },
        started_at: t(300_000 - 1310),
        duration_ms: 100,
        tokens_used: 200,
        metadata: {},
      },
      {
        step_number: 8,
        step_type: 'tool_call',
        name: 'create_booking',
        caused_by_step: 7,
        input: {
          flight_id: 'fl_3',
          passenger: { name: 'John Doe', user_id: 'usr_7823' },
          class: 'economy',
          payment_method: 'card_on_file',
        },
        output: {
          success: true,
          pnr: 'XYZ789',
          total_charged: 299.0,
          currency: 'USD',
        },
        started_at: t(300_000 - 1410),
        duration_ms: 1150,
        tokens_used: 400,
        metadata: { tool: 'booking_api' },
        snapshot: {
          context_window: { messages: 8, total_tokens: 3300 },
          environment: { api_calls: 2, booking_created: true },
          tool_state: { flight_api: 'connected', booking_api: 'connected' },
          token_count: 3300,
        },
      },
      {
        step_number: 9,
        step_type: 'llm_call',
        name: 'generate_confirmation',
        parent_step: 8,
        caused_by_step: 8,
        input: { pnr: 'XYZ789', flight: 'B6 212', price: 299.0 },
        output: {
          text: 'Your flight has been booked! Confirmation: XYZ789, B6 212 SFO→JFK departing 14:00. Total: $299.00.',
        },
        started_at: t(300_000 - 2560),
        duration_ms: 390,
        tokens_used: 500,
        model: 'gpt-4.1',
        metadata: { temperature: 0.2 },
      },
      {
        step_number: 10,
        step_type: 'output',
        name: 'send_confirmation',
        input: { message_type: 'booking_confirmation', pnr: 'XYZ789' },
        output: { delivered: true, message_id: 'msg_9105', push_notification_sent: true },
        started_at: t(300_000 - 2950),
        duration_ms: 170,
        tokens_used: 300,
        metadata: {},
      },
    ],
  };
}
