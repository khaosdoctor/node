'use strict';

const {
  emitExperimentalWarning,
} = require('internal/util');

const {
  ArrayPrototypeAt,
  ArrayPrototypeForEach,
  ArrayPrototypeIncludes,
  DatePrototypeGetTime,
  DatePrototypeToString,
  FunctionPrototypeApply,
  FunctionPrototypeBind,
  FunctionPrototypeToString,
  globalThis,
  MathAbs,
  NumberIsNaN,
  ObjectAssign,
  ObjectDefineProperties,
  ObjectGetOwnPropertyDescriptors,
  Promise,
  Symbol,
  SymbolAsyncIterator,
  SymbolDispose,
} = primordials;
const {
  validateAbortSignal,
  validateArray,
  validateNumber,
} = require('internal/validators');

const {
  AbortError,
  codes: { ERR_INVALID_STATE, ERR_INVALID_ARG_VALUE },
} = require('internal/errors');

const PriorityQueue = require('internal/priority_queue');
const nodeTimers = require('timers');
const nodeTimersPromises = require('timers/promises');
const EventEmitter = require('events');

let kResistStopPropagation;
// Internal reference to the MockTimers class inside MockDate
let kMock;
// Initial epoch to which #now should be set to
const kInitialEpoch = 0;

function compareTimersLists(a, b) {
  return a.runAt - b.runAt || a.id - b.id;
}

function setPosition(node, pos) {
  node.priorityQueuePosition = pos;
}

function abortIt(signal) {
  return new AbortError(undefined, { cause: signal.reason });
}

const SUPPORTED_APIS = ['setTimeout', 'setInterval', 'Date'];

/**
 * @typedef {{apis: string[];now: number | Date;}} EnableOptions Options to enable the timers
 * @property {string[]} apis List of timers to enable, defaults to all
 * @property {number | Date} now The epoch to which the timers should be set to, defaults to 0
 */

class MockTimers {
  #realSetTimeout;
  #realClearTimeout;
  #realSetInterval;
  #realClearInterval;

  #realPromisifiedSetTimeout;
  #realPromisifiedSetInterval;

  #realTimersSetTimeout;
  #realTimersClearTimeout;
  #realTimersSetInterval;
  #realTimersClearInterval;

  #RealDate;

  #timersInContext = [];
  #isEnabled = false;
  #currentTimer = 1;
  #now = kInitialEpoch;

  #executionQueue = new PriorityQueue(compareTimersLists, setPosition);

  #setTimeout = FunctionPrototypeBind(this.#createTimer, this, false);
  #clearTimeout = FunctionPrototypeBind(this.#clearTimer, this);
  #setInterval = FunctionPrototypeBind(this.#createTimer, this, true);
  #clearInterval = FunctionPrototypeBind(this.#clearTimer, this);

  constructor() {
    emitExperimentalWarning('The MockTimers API');
  }

  #createTimer(isInterval, callback, delay, ...args) {
    const timerId = this.#currentTimer++;
    this.#executionQueue.insert({
      __proto__: null,
      id: timerId,
      callback,
      runAt: this.#now + delay,
      interval: isInterval,
      args,
    });

    return timerId;
  }

  #clearTimer(position) {
    this.#executionQueue.removeAt(position);
  }

  #createDate() {
    kMock ??= Symbol('MockTimers');
    /**
     * Function to mock the Date constructor, treats cases as per ECMA-262
     * and returns a Date object with a mocked implementation
     * @typedef {Date} MockDate
     * @returns {MockDate} a mocked Date object
     */
    function MockDate(year, month, date, hours, minutes, seconds, ms) {
      const mockTimersSource = MockDate[kMock];
      const nativeDate = mockTimersSource.#RealDate;
      // As of the fake-timers implementation for Sinon
      // ref https://github.com/sinonjs/fake-timers/blob/a4c757f80840829e45e0852ea1b17d87a998388e/src/fake-timers-src.js#L456
      // This covers the Date constructor called as a function ref.
      // ECMA-262 Edition 5.1 section 15.9.2.
      // and ECMA-262 Edition 14 Section 21.4.2.1
      if (!(this instanceof MockDate)) {
        return DatePrototypeToString(new nativeDate(mockTimersSource.#now));
      }

      // Cases where Date is called as a constructor
      // This is intended as a defensive implementation to avoid
      // having unexpected returns
      switch (arguments.length) {
        case 0:
          return new nativeDate(MockDate[kMock].#now);
        case 1:
          return new nativeDate(year);
        case 2:
          return new nativeDate(year, month);
        case 3:
          return new nativeDate(year, month, date);
        case 4:
          return new nativeDate(year, month, date, hours);
        case 5:
          return new nativeDate(year, month, date, hours, minutes);
        case 6:
          return new nativeDate(year, month, date, hours, minutes, seconds);
        default:
          return new nativeDate(year, month, date, hours, minutes, seconds, ms);
      }
    }

    // Prototype is read-only, and non assignable through Object.defineProperties
    // eslint-disable-next-line no-unused-vars -- used to get the prototype out of the object
    const { prototype, ...dateProps } = ObjectGetOwnPropertyDescriptors(this.#RealDate);

    // Binds all the properties of Date to the MockDate function
    ObjectDefineProperties(
      MockDate,
      dateProps,
    );

    MockDate.now = function now() {
      return MockDate[kMock].#now;
    };

    // This is just to print the function { native code } in the console
    // when the user prints the function and not the internal code
    MockDate.toString = function toString() {
      return FunctionPrototypeToString(MockDate[kMock].#RealDate);
    };

    MockDate.prototype = this.#RealDate.prototype;
    MockDate.parse = this.#RealDate.parse;
    MockDate.UTC = this.#RealDate.UTC;
    MockDate.prototype.toUTCString = this.#RealDate.prototype.toUTCString;
    MockDate.isMock = true;
    MockDate[kMock] = this;

    return MockDate;
  }

  async *#setIntervalPromisified(interval, startTime, options) {
    const context = this;
    const emitter = new EventEmitter();
    if (options?.signal) {
      validateAbortSignal(options.signal, 'options.signal');

      if (options.signal.aborted) {
        throw abortIt(options.signal);
      }

      const onAbort = (reason) => {
        emitter.emit('data', { __proto__: null, aborted: true, reason });
      };

      kResistStopPropagation ??= require('internal/event_target').kResistStopPropagation;
      options.signal.addEventListener('abort', onAbort, {
        __proto__: null,
        once: true,
        [kResistStopPropagation]: true,
      });
    }

    const eventIt = EventEmitter.on(emitter, 'data');
    const callback = () => {
      startTime += interval;
      emitter.emit('data', startTime);
    };

    const timerId = this.#createTimer(true, callback, interval, options);
    const clearListeners = () => {
      emitter.removeAllListeners();
      context.#clearTimer(timerId);
    };
    const iterator = {
      __proto__: null,
      [SymbolAsyncIterator]() {
        return this;
      },
      async next() {
        const result = await eventIt.next();
        const value = ArrayPrototypeAt(result.value, 0);
        if (value?.aborted) {
          iterator.return();
          throw abortIt(options.signal);
        }

        return {
          __proto__: null,
          done: result.done,
          value,
        };
      },
      async return() {
        clearListeners();
        return eventIt.return();
      },
    };
    yield* iterator;
  }

  #setTimeoutPromisified(ms, result, options) {
    return new Promise((resolve, reject) => {
      if (options?.signal) {
        try {
          validateAbortSignal(options.signal, 'options.signal');
        } catch (err) {
          return reject(err);
        }

        if (options.signal.aborted) {
          return reject(abortIt(options.signal));
        }
      }

      const onabort = () => {
        this.#clearTimeout(id);
        return reject(abortIt(options.signal));
      };

      const id = this.#setTimeout(() => {
        return resolve(result || id);
      }, ms);

      if (options?.signal) {
        kResistStopPropagation ??= require('internal/event_target').kResistStopPropagation;
        options.signal.addEventListener('abort', onabort, {
          __proto__: null,
          once: true,
          [kResistStopPropagation]: true,
        });
      }
    });
  }

  #assertTimersAreEnabled() {
    if (!this.#isEnabled) {
      throw new ERR_INVALID_STATE(
        'You should enable MockTimers first by calling the .enable function',
      );
    }
  }

  #assertTimeArg(time) {
    if (time < 0) {
      throw new ERR_INVALID_ARG_VALUE('time', 'positive integer', time);
    }
  }

  #toggleEnableTimers(activate) {
    const options = {
      toFake: {
        setTimeout: () => {
          this.#realSetTimeout = globalThis.setTimeout;
          this.#realClearTimeout = globalThis.clearTimeout;
          this.#realTimersSetTimeout = nodeTimers.setTimeout;
          this.#realTimersClearTimeout = nodeTimers.clearTimeout;
          this.#realPromisifiedSetTimeout = nodeTimersPromises.setTimeout;

          globalThis.setTimeout = this.#setTimeout;
          globalThis.clearTimeout = this.#clearTimeout;

          nodeTimers.setTimeout = this.#setTimeout;
          nodeTimers.clearTimeout = this.#clearTimeout;

          nodeTimersPromises.setTimeout = FunctionPrototypeBind(
            this.#setTimeoutPromisified,
            this,
          );
        },
        setInterval: () => {
          this.#realSetInterval = globalThis.setInterval;
          this.#realClearInterval = globalThis.clearInterval;
          this.#realTimersSetInterval = nodeTimers.setInterval;
          this.#realTimersClearInterval = nodeTimers.clearInterval;
          this.#realPromisifiedSetInterval = nodeTimersPromises.setInterval;

          globalThis.setInterval = this.#setInterval;
          globalThis.clearInterval = this.#clearInterval;

          nodeTimers.setInterval = this.#setInterval;
          nodeTimers.clearInterval = this.#clearInterval;

          nodeTimersPromises.setInterval = FunctionPrototypeBind(
            this.#setIntervalPromisified,
            this,
          );
        },
        Date: () => {
          this.#RealDate = globalThis.Date;
          globalThis.Date = this.#createDate();
        },
      },
      toReal: {
        setTimeout: () => {
          globalThis.setTimeout = this.#realSetTimeout;
          globalThis.clearTimeout = this.#realClearTimeout;

          nodeTimers.setTimeout = this.#realTimersSetTimeout;
          nodeTimers.clearTimeout = this.#realTimersClearTimeout;

          nodeTimersPromises.setTimeout = this.#realPromisifiedSetTimeout;
        },
        setInterval: () => {
          globalThis.setInterval = this.#realSetInterval;
          globalThis.clearInterval = this.#realClearInterval;

          nodeTimers.setInterval = this.#realTimersSetInterval;
          nodeTimers.clearInterval = this.#realTimersClearInterval;

          nodeTimersPromises.setInterval = this.#realPromisifiedSetInterval;
        },
        Date: () => {
          globalThis.Date = this.#RealDate;
        },
      },
    };

    const target = activate ? options.toFake : options.toReal;
    ArrayPrototypeForEach(this.#timersInContext, (timer) => target[timer]());
    this.#isEnabled = activate;
  }

  #isValidDateWithGetTime(maybeDate) {
    // Validation inspired on https://github.com/inspect-js/is-date-object/blob/main/index.js#L3-L11
    try {
      DatePrototypeGetTime(maybeDate);
      return true;
    } catch {
      return false;
    }
  }

  tick(ms = 1) {
    this.#assertTimersAreEnabled();
    this.#assertTimeArg(ms);

    this.#now += ms;
    let timer = this.#executionQueue.peek();
    while (timer) {
      if (timer.runAt > this.#now) break;
      FunctionPrototypeApply(timer.callback, undefined, timer.args);

      this.#executionQueue.shift();

      if (timer.interval) {
        timer.runAt += timer.interval;
        this.#executionQueue.insert(timer);
        return;
      }

      timer = this.#executionQueue.peek();
    }
  }

  /**
   * Enables the MockTimers replacing the native timers with the fake ones.
   * @param {EnableOptions} options
   */
  enable(options = { apis: SUPPORTED_APIS, now: 0 }) {
    const internalOptions = ObjectAssign({}, options)
    if (this.#isEnabled) {
      throw new ERR_INVALID_STATE('MockTimers is already enabled!');
    }

    if (NumberIsNaN(internalOptions.now)) {
      throw new ERR_INVALID_ARG_VALUE('now', internalOptions.now, `epoch must be a positive integer received ${internalOptions.now}`);
    }

    if (!internalOptions.now) {
      internalOptions.now = 0;
    }

    if (!internalOptions.apis) {
      internalOptions.apis = SUPPORTED_APIS;
    }

    validateArray(internalOptions.apis, 'timers');
    // Check that the timers passed are supported
    ArrayPrototypeForEach(internalOptions.apis, (timer) => {
      if (!ArrayPrototypeIncludes(SUPPORTED_APIS, timer)) {
        throw new ERR_INVALID_ARG_VALUE(
          'timers',
          timer,
          `option ${timer} is not supported`,
        );
      }
    });
    this.#timersInContext = internalOptions.apis;

    // Checks if the second argument is the initial time
    if (this.#isValidDateWithGetTime(internalOptions.now)) {
      this.#now = DatePrototypeGetTime(internalOptions.now);
    } else if (validateNumber(internalOptions.now, 'initialTime') === undefined) {
      this.#assertTimeArg(internalOptions.now);
      this.#now = internalOptions.now;
    }

    this.#toggleEnableTimers(true);
  }

  /**
   * Sets the current time to the given epoch.
   * @param {number} time The epoch to set the current time to.
   */
  setTime(time = kInitialEpoch) {
    validateNumber(time, 'time');
    this.#assertTimeArg(time);
    this.#assertTimersAreEnabled();

    if (time < this.#now) {
      this.#now = time;
      return;
    }

    this.tick(MathAbs(time - this.#now));
  }

  [SymbolDispose]() {
    this.reset();
  }

  reset() {
    // Ignore if not enabled
    if (!this.#isEnabled) return;

    this.#toggleEnableTimers(false);
    this.#timersInContext = [];
    this.#now = kInitialEpoch;

    let timer = this.#executionQueue.peek();
    while (timer) {
      this.#executionQueue.shift();
      timer = this.#executionQueue.peek();
    }
  }

  runAll() {
    this.#assertTimersAreEnabled();
    const longestTimer = this.#executionQueue.peekBottom();
    if (!longestTimer) return;
    this.tick(longestTimer.runAt - this.#now);
  }
}

module.exports = { MockTimers };
