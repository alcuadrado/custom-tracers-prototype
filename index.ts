import * as QuickJS from "quickjs-emscripten";
import util from "util";

interface MockLog {
  value: number;
}

interface MockStateManager {
  read(key: string): Promise<number>;
  write(key: string, value: number): Promise<void>;
}

function getMockStateManager(): MockStateManager {
  let state: { [key: string]: number } = {};

  let stateManager = {
    async read(key: string): Promise<number> {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return state[key] ?? 0;
    },
    async write(key: string, value: number): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 300));
      state[key] = value;
    },
  };

  return stateManager;
}

interface ConsoleHandler {
  log(...args: any[]): void;
  error(...args: any[]): void;
}

function getMockConsoleHandler(): ConsoleHandler {
  return {
    log(...args: any[]) {
      console.log(`[tracer console.log]`, util.format(...args));
    },
    error(...args: any[]) {
      console.log(`[tracer console.error]`, util.format(...args));
    },
  };
}

async function main() {
  const stateManager = getMockStateManager();
  const consoleHandler = getMockConsoleHandler();

  // QuickJS requires you to do some manual memory management.
  // To understand why you need to consider that we have 3 different
  // runtimes in place: v8, wasm, and QuickJS. Wasm has no automatic
  // memory management. Both v8 and QuickJS have GCs.
  //
  // When you want to access/create QuickJS values from v8,
  // you need a handle into a value that lives inside a different runtime.
  // The handle itself lives in wasm, and can't be collected by either GC,
  // as its not exclusively owned by them. You have to manually dispose your
  // handles instead.
  //
  // Scope is a handy class to collect everything at the end of its lifetime, but it's
  // not the best thing for temporary values, as you'd be leaking them until the end
  // of the scope.
  //
  // Useful read: https://github.com/justjake/quickjs-emscripten?tab=readme-ov-file#memory-management
  await QuickJS.Scope.withScopeAsync(async (scope) => {
    const vm = scope.manage(await QuickJS.newAsyncContext());

    // TODO: This callback should return `true` after a deadline for an evaluation
    // is met. QuickJS calls it regularly to ask if it should interrupt the execution.
    // Maybe we can set different interrupt handlers for each evaluation? I don't know
    // what's better.
    vm.runtime.setInterruptHandler(() => false);

    // TODO: Do we need to change the default stack and memory size limits
    // vm.runtime.setMaxStackSize(...)
    // vm.runtime.setMemoryLimit(...)

    // TODO: Do we need to set an unhandled promise rejection handler?

    // Set the global console object
    const consoleHandle = scope.manage(getConsoleHandler(vm, consoleHandler));
    vm.setProp(vm.global, "console", consoleHandle);

    const db = scope.manage(getDbHandler(vm, stateManager));

    // Note that when evaluating a tracer we may need to wrap it in parens like
    // I did here. That's because without the parens a top level "object literal"
    // is in fact a block statement and we'll get into either syntax errors or
    // unexpected results.
    // Geth doesn't seem to require those (), so people will send us code without
    // them.
    const tracerString = `({
      step(log, db) {
        const oldFoo = db.read("foo");
        console.log("Old value %o", oldFoo);
        
        db.write("foo", log.value);

        console.log("New value %o", db.read("foo"));
      }
    })`;

    const tracerHandle = scope.manage(await evaluateTracer(vm, tracerString));

    console.log("Setting foo to 0");
    await stateManager.write("foo", 0);

    console.log("Evaluating step");
    await evaluateSetp(vm, tracerHandle, { value: 123 }, db);

    console.log("New value after step is", await stateManager.read("foo"));
  });
}

// Memory management note: I think a good pattern for these functions
// can be disposing any temporary handle that they create before
// returning, but NOT managing the handles that it returns, so that
// disposing them would be a responsibility of the caller.
function getDbHandler(
  vm: QuickJS.QuickJSAsyncContext,
  stateManager: MockStateManager
): QuickJS.QuickJSHandle {
  const db = vm.newObject();

  const readCallback = async (keyHandle: QuickJS.QuickJSHandle) => {
    // TODO: What happens if this is not a string?
    const key = vm.getString(keyHandle);

    const value = await stateManager.read(key);

    return vm.newNumber(value);
  };

  const writeCallback = async (
    keyHandle: QuickJS.QuickJSHandle,
    valueHandle: QuickJS.QuickJSHandle
  ) => {
    // TODO: What happens if this is not a string?
    const key = vm.getString(keyHandle);

    // TODO: What happens if this is not a number?
    const value = vm.getNumber(valueHandle);

    await stateManager.write(key, value);
  };

  vm.newAsyncifiedFunction("read", readCallback).consume((dbRead) => {
    vm.setProp(db, "read", dbRead);
  });

  vm.newAsyncifiedFunction("write", writeCallback).consume((dbWrite) => {
    vm.setProp(db, "write", dbWrite);
  });

  return db;
}

function getConsoleHandler(
  vm: QuickJS.QuickJSAsyncContext,
  consoleHandler: ConsoleHandler
): QuickJS.QuickJSHandle {
  const console = vm.newObject();

  vm.newFunction("log", (...args) => {
    const nativeArgs = args.map(vm.dump);
    consoleHandler.log(...nativeArgs);
  }).consume((log) => {
    vm.setProp(console, "log", log);
  });

  vm.newFunction("error", (...args) => {
    const nativeArgs = args.map(vm.dump);
    consoleHandler.error(...nativeArgs);
  }).consume((error) => {
    vm.setProp(console, "error", error);
  });

  return console;
}

async function evaluateTracer(
  vm: QuickJS.QuickJSAsyncContext,
  tracerDefintion: string
): Promise<QuickJS.QuickJSHandle> {
  // `unwrapResult` will throw if the result is an error (i.e. the evaluation failed with an exception)
  // We can also handle it manually, as I did in `evaluateSetp`.
  const tracerHandle = vm.unwrapResult(
    await vm.evalCodeAsync(tracerDefintion, "[tracer]", {
      strict: false, // Do we need to set "strict mode" to true? We should mimic Geth.
    })
  );

  if (vm.typeof(tracerHandle) !== "object") {
    throw new Error("The tracer is not an object");
  }

  // TODO: What if the tracer is null?

  return tracerHandle;
}

async function evaluateSetp(
  vm: QuickJS.QuickJSAsyncContext,
  tracerHandle: QuickJS.QuickJSHandle,
  log: MockLog,
  dbHandle: QuickJS.QuickJSHandle
) {
  // We need to be able to await for our async host functions, despite them
  // showing a sync interface to QuickJS. We do this by using `evalCodeAsync`,
  // as I couldn't find another way. This is a bit of a hack, we define
  // a function that calls the step handler, and then we evaluate that function.
  //
  // Basically, we're doing this:
  //
  // ```
  // global.__db = <db>;
  // global.__tracer = <tracer>;
  // global.__log = <log>;
  // ```
  //
  // And then we evaluate this:
  //
  // ```
  // __tracer.step(__log, __db)
  // ```

  // TODO: No need to set __db and __tracer every time.
  vm.setProp(vm.global, "__db", dbHandle);
  vm.setProp(vm.global, "__tracer", tracerHandle);

  vm.newObject().consume((logHandle) => {
    vm.newNumber(log.value).consume((valueHandle) => {
      vm.setProp(logHandle, "value", valueHandle);
    });

    vm.setProp(vm.global, "__log", logHandle);
  });

  const result = await vm.evalCodeAsync(`__tracer.step(__log, __db)`, "[main]");
  if (QuickJS.isSuccess(result)) {
    console.log("successful step");
    // Immediately dispose the result, as we don't need it
    // and we'll call this function many times.
    result.value.dispose();
  } else {
    console.error(getFormattedError(vm, result.error));

    // We also dispose the error immediately.
    result.error.dispose();
  }
}

function getFormattedError(
  vm: QuickJS.QuickJSAsyncContext,

  errorHandle: QuickJS.QuickJSHandle
): string {
  // TODO: Check that this is actually an instance of Error
  // TODO: Does QuickJS support Error.cause? I don't think so.
  const error = vm.dump(errorHandle);
  return `${error.name}: ${error.message}
${error.stack}`;
}

main();
