import { EventTarget, Event } from 'event-target-shim';

export type EventName =
  | 'attempt'
  | 'attemptFailure'
  | 'chunkSuccess'
  | 'error'
  | 'offline'
  | 'online'
  | 'progress'
  | 'success';

// NOTE: This and the EventTarget definition below could be more precise
// by e.g. typing the detail of the CustomEvent per EventName.
type UpchunkEvent = CustomEvent & Event<EventName>;

export class EventDispatcher{
    public eventTarget: EventTarget<Record<EventName, UpchunkEvent>>;

    constructor() {
        this.eventTarget = new EventTarget();
    }

    
  /**
   * Dispatch an event
   */
  public dispatch(eventName: EventName, detail?: any) {
    const event: UpchunkEvent = new CustomEvent(eventName, {
      detail,
    }) as UpchunkEvent;

    this.eventTarget.dispatchEvent(event);
  }
    
}