/**
 * Every capability this build knows, in registration order.
 *
 * ORDER IS THE TOOL ORDER the model sees, and it is deliberate: the built-ins
 * that always work come first, then the ones a deployment has to configure.
 *
 * ADDING A CAPABILITY IS ADDING A FILE AND A LINE HERE. That is the whole point
 * of ./types.ts — medication reminders, daily check-ins and vitals logging were
 * the next three, and none of them required editing anybody else's
 * registration code.
 */

import type { Capability } from "./types.ts";
import { coreCapability } from "./core.ts";
import { gamesCapability } from "./games.ts";
import { wellbeingCapability } from "./wellbeing.ts";
import { medicationCapability } from "./medication.ts";
import { checkinCapability } from "./checkin.ts";
import { vitalsCapability } from "./vitals.ts";
import { weatherCapability } from "./weather.ts";
import { newsCapability } from "./news.ts";
import { musicCapability } from "./music.ts";
import { calendarCapability } from "./calendar.ts";
import { emergencyCapability } from "./emergency.ts";

export const CAPABILITIES: readonly Capability[] = [
  coreCapability,
  gamesCapability,
  wellbeingCapability,
  // Before the external ones because it is closer to the core of what this
  // product is for, and after wellbeing because it depends on nothing wellbeing
  // does. It is also the first entry whose tools can act between turns.
  medicationCapability,
  checkinCapability,
  // After the two that speak on their own and before the external ones. It is
  // an outbound call like weather and news, but to our own service, about the
  // person rather than about the world.
  vitalsCapability,
  weatherCapability,
  newsCapability,
  musicCapability,
  calendarCapability,
  emergencyCapability,
];
