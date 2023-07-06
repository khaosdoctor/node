'use strict';

const {
  emitExperimentalWarning,
} = require('internal/util');

const {
  ArrayPrototypeAt,
  ArrayPrototypeForEach,
  ArrayPrototypeIncludes,
  DateNow,
  FunctionPrototypeApply,
  FunctionPrototypeBind,
  Promise,
  SymbolAsyncIterator,
  SymbolDispose,
  globalThis,
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
const { MathAbs } = primordials;

let kResistStopPropagation;

function compareTimersLists(a, b) {
  return a.runAt - b.runAt || a.id - b.id;
}

function setPosition(node, pos) {
  node.priorityQueuePosition = pos;
}

function abortIt(signal) {
  return new AbortError(undefined, { cause: signal.reason });
}

const SUPPORTED_TIMERS = ['setTimeout', 'setInterval', 'Date'];

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

  #realDate;

  #timersInContext = [];
  #isEnabled = false;
  #currentTimer = 1;
  #now = 0;

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
    const kMock = Symbol('MockTimers');
    /**
     * Function to mock the Date constructor, treats cases as per ECMA-262
     * and returns a Date object with a mocked implementation
     * @typedef {Date} MockDate
     * @returns {MockDate} a mocked Date object
     */
    function MockDate(year, month, date, hours, minutes, seconds, ms) {
      // As of the fake-timers implementation for Sinon
      // ref https://github.com/sinonjs/fake-timers/blob/a4c757f80840829e45e0852ea1b17d87a998388e/src/fake-timers-src.js#L456
      // This covers the Date constructor called as a function ref.
      // ECMA-262 Edition 5.1 section 15.9.2.
      // and ECMA-262 Edition 14 Section 21.4.2.1
      if (!(this instanceof MockDate)) {
        return new this.#realDate(this.#now).toString();
      }

      const mockTimersSource = MockDate[kMock];
      const nativeDate = mockTimersSource.#realDate;

      // Cases where Date is called as a constructor
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
          return new MockDate[kDate](
            year,
            month,
            date,
            hours,
            minutes,
            seconds,
            ms
          );
      }
    }

    // Binds all the properties of Date to the MockDate function
    for (const prop in this.#realDate) {
      if (this.#realDate.hasOwn(prop)) {
        MockDate[prop] = this.#realDate[prop];
      }
    }

    MockDate.now = function now() {
      return this.#now;
    };

    MockDate.toString = function toString() {
      return this.#realDate.toString();
    };

    MockDate.prototype = this.#realDate.prototype;
    MockDate.parse = this.#realDate.parse;
    MockDate.UTC = this.#realDate.UTC;
    MockDate.prototype.toUTCString = this.#realDate.prototype.toUTCString;
    MockDate.isMock = true;
    MockDate[kMock] = this;

    return MockDate.bind(this);
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

      kResistStopPropagation ??=
        require('internal/event_target').kResistStopPropagation;
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
        kResistStopPropagation ??=
          require('internal/event_target').kResistStopPropagation;
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
        'You should enable MockTimers first by calling the .enable function'
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
            this
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
            this
          );
        },
        Date: () => {
          this.#realDate = globalThis.Date;
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
          globalThis.Date = this.#realDate;
        },
      },
    };

    const target = activate ? options.toFake : options.toReal;
    ArrayPrototypeForEach(this.#timersInContext, (timer) => target[timer]());
    this.#isEnabled = activate;
  }

  tick(time = 1) {
    this.#assertTimersAreEnabled();
    this.#assertTimeArg(time);

    this.#now += time;
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

  enable(timers = SUPPORTED_TIMERS, currentTime = 0) {
    if (this.#isEnabled) {
      throw new ERR_INVALID_STATE('MockTimers is already enabled!');
    }

    validateArray(timers, 'timers');

    // Check that the timers passed are supported
    ArrayPrototypeForEach(timers, (timer) => {
      if (!ArrayPrototypeIncludes(SUPPORTED_TIMERS, timer)) {
        throw new ERR_INVALID_ARG_VALUE(
          'timers',
          timer,
          `option ${timer} is not supported`
        );
      }
    });

    this.#timersInContext = timers;

    if (
      currentTime instanceof globalThis.Date &&
      'getTime' in currentTime &&
      typeof currentTime.getTime === 'function'
    ) {
      this.#now = currentTime.getTime();
    } else if (validateNumber(currentTime, 'currentTime') === undefined) {
      this.#assertTimeArg(currentTime);
      this.#now = currentTime;
    }

    this.#toggleEnableTimers(true);
  }

  setTime(time = 0) {
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
    this.#now = DateNow();

    let timer = this.#executionQueue.peek();
    while (timer) {
      this.#executionQueue.shift();
      timer = this.#executionQueue.peek();
    }
  }

  runAll() {
    this.#assertTimersAreEnabled();
    this.tick(Infinity);
  }
}

module.exports = { MockTimers };
