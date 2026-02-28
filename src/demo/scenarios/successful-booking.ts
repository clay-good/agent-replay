import type { IngestTraceInput } from '../../models/types.js';

/**
 * Scenario 4: Successful Flight Booking (COMPLETED)
 *
 * A travel assistant successfully handles a flight booking request.
 * Clean execution: intent analysis → search → present options → user
 * confirmation → book → confirmation. Used as the "good" trace for
 * diffing against scenario 1.
 *
 * 10 steps, ~4.5k tokens, 3.2s.
 */
export function successfulBooking(baseTime: Date): IngestTraceInput {
  const t = (offsetMs: number) => new Date(baseTime.getTime() - offsetMs).toISOString();

  return {
    agent_name: 'travel-assistant',
    agent_version: '4.2.0',
    trigger: 'user_message',
    status: 'completed',
    input: {
      user_message: 'Book me a flight from SFO to JFK next Friday, economy class',
      user_id: 'usr_7823',
      preferences: { airline: 'any', stops: 'nonstop_preferred' },
    },
    output: {
      booking_confirmation: {
        pnr: 'ABC123',
        flight: 'UA 456',
        departure: 'SFO 08:30',
        arrival: 'JFK 17:05',
        class: 'economy',
        price_usd: 342.50,
      },
      message: 'Your flight has been booked! Confirmation: ABC123, UA 456 SFO→JFK departing 08:30.',
    },
    started_at: t(900_000), // 15 min ago
    ended_at: t(900_000 - 3_200),
    total_duration_ms: 3200,
    total_tokens: 4500,
    total_cost_usd: 0.018,
    error: null,
    tags: ['travel', 'booking', 'success'],
    metadata: { environment: 'production', channel: 'mobile_app' },
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
        started_at: t(900_000),
        duration_ms: 120,
        tokens_used: 400,
        metadata: {},
      },
      {
        step_number: 2,
        step_type: 'tool_call',
        name: 'resolve_date',
        input: { relative_date: 'next Friday' },
        output: { resolved_date: '2026-03-06', day_of_week: 'Friday' },
        started_at: t(900_000 - 120),
        duration_ms: 30,
        tokens_used: 50,
        metadata: { tool: 'date_resolver' },
      },
      {
        step_number: 3,
        step_type: 'tool_call',
        name: 'search_flights',
        input: { origin: 'SFO', destination: 'JFK', date: '2026-03-06', class: 'economy' },
        output: {
          flights: [
            { id: 'fl_1', airline: 'United', flight: 'UA 456', depart: '08:30', arrive: '17:05', price: 342.50, stops: 0 },
            { id: 'fl_2', airline: 'Delta', flight: 'DL 890', depart: '10:15', arrive: '19:00', price: 378.00, stops: 0 },
            { id: 'fl_3', airline: 'JetBlue', flight: 'B6 212', depart: '14:00', arrive: '22:30', price: 299.00, stops: 1 },
          ],
          total_results: 3,
        },
        started_at: t(900_000 - 150),
        duration_ms: 450,
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
          recommended: 'fl_1',
          reasoning: 'Nonstop, lowest price among nonstop options, early departure',
          ranking: ['fl_1', 'fl_2', 'fl_3'],
        },
        started_at: t(900_000 - 600),
        duration_ms: 80,
        tokens_used: 300,
        metadata: {},
      },
      {
        step_number: 5,
        step_type: 'llm_call',
        name: 'format_options_message',
        input: { ranked_flights: ['fl_1', 'fl_2', 'fl_3'], recommended: 'fl_1' },
        output: {
          text: "I found 3 flights for you:\n\n✈ **Recommended:** UA 456 — SFO 08:30→JFK 17:05 — $342.50 (nonstop)\n  DL 890 — SFO 10:15→JFK 19:00 — $378.00 (nonstop)\n  B6 212 — SFO 14:00→JFK 22:30 — $299.00 (1 stop)\n\nShall I book UA 456?",
        },
        started_at: t(900_000 - 680),
        duration_ms: 600,
        tokens_used: 800,
        model: 'gpt-4-turbo',
        metadata: { temperature: 0.3 },
      },
      {
        step_number: 6,
        step_type: 'output',
        name: 'present_options',
        input: { message_type: 'flight_options', options_count: 3 },
        output: { delivered: true, message_id: 'msg_8891' },
        started_at: t(900_000 - 1280),
        duration_ms: 40,
        tokens_used: 50,
        metadata: {},
      },
      {
        step_number: 7,
        step_type: 'thought',
        name: 'process_user_confirmation',
        input: { user_response: 'Yes, book the United flight', selected_flight: 'fl_1' },
        output: { action: 'proceed_with_booking', flight_id: 'fl_1' },
        started_at: t(900_000 - 1320),
        duration_ms: 100,
        tokens_used: 200,
        metadata: {},
      },
      {
        step_number: 8,
        step_type: 'tool_call',
        name: 'create_booking',
        input: {
          flight_id: 'fl_1',
          passenger: { name: 'John Doe', user_id: 'usr_7823' },
          class: 'economy',
          payment_method: 'card_on_file',
        },
        output: {
          success: true,
          pnr: 'ABC123',
          total_charged: 342.50,
          currency: 'USD',
        },
        started_at: t(900_000 - 1420),
        duration_ms: 1200,
        tokens_used: 400,
        metadata: { tool: 'booking_api' },
        snapshot: {
          context_window: { messages: 8, total_tokens: 3200 },
          environment: { api_calls: 2, booking_created: true },
          tool_state: { flight_api: 'connected', booking_api: 'connected' },
          token_count: 3200,
        },
      },
      {
        step_number: 9,
        step_type: 'llm_call',
        name: 'generate_confirmation',
        input: { pnr: 'ABC123', flight: 'UA 456', price: 342.50 },
        output: {
          text: 'Your flight has been booked! Confirmation: ABC123, UA 456 SFO→JFK departing 08:30. Total: $342.50.',
        },
        started_at: t(900_000 - 2620),
        duration_ms: 400,
        tokens_used: 500,
        model: 'gpt-4-turbo',
        metadata: { temperature: 0.2 },
      },
      {
        step_number: 10,
        step_type: 'output',
        name: 'send_confirmation',
        input: { message_type: 'booking_confirmation', pnr: 'ABC123' },
        output: { delivered: true, message_id: 'msg_8892', push_notification_sent: true },
        started_at: t(900_000 - 3020),
        duration_ms: 180,
        tokens_used: 200,
        metadata: {},
      },
    ],
  };
}
