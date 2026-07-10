using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Witch.Mod;
using Witch.UI.Window;

namespace CodexMcpBridge
{
    public static class EntryPoint
    {
        [ModInitialize]
        public static void Entry(ModConfig modConfig)
        {
            BridgeServer.Start();
        }
    }

    public static class BridgePatch
    {
        [HookAfter(typeof(SettingUI), nameof(SettingUI.OnEnable))]
        public static void OnSettingEnabled(SettingUI __instance)
        {
            BridgeServer.Pump();
        }

        [HookAfter(typeof(GameEntryUI), nameof(GameEntryUI.Init))]
        public static void OnGameEntryInit(GameEntryUI __instance)
        {
            BridgeServer.Pump();
        }

        [HookAfter(typeof(TopBarUI), nameof(TopBarUI.ShowLeftUp))]
        public static void OnTopBarShowLeftUp(TopBarUI __instance)
        {
            BridgeServer.Pump();
        }
    }

    internal sealed class WorkItem
    {
        public string Command;
        public JObject Params;
        public ManualResetEvent Done = new ManualResetEvent(false);
        public object Result;
        public object Awaiter;
        public MethodInfo GetResult;
        public DateTime DeadlineUtc;
        public bool Cancelled;
    }

    internal sealed class MapSlotFill
    {
        public bool ok;
        public bool filled;
        public string reason;
        public object slot;
        public string contentPath;
        public int childCount;
        public List<object> children = new List<object>();
    }

    public static class BridgeServer
    {
        private const string Prefix = "http://127.0.0.1:18171/";
        private const int BridgeCommandTimeoutMs = 30000;
        private const string BridgeVersion = "0.9.0";
        private static readonly object Gate = new object();
        private static readonly Queue<WorkItem> Queue = new Queue<WorkItem>();
        private static readonly List<WorkItem> Pending = new List<WorkItem>();
        private static HttpListener _listener;
        private static Thread _thread;
        private static bool _running;

        public static void Start()
        {
            if (_running)
                return;

            try
            {
                EnsureRunner();
                _listener = new HttpListener();
                _listener.Prefixes.Add(Prefix);
                _listener.Start();
                _running = true;
                _thread = new Thread(ListenLoop);
                _thread.IsBackground = true;
                _thread.Start();
                Debug.Log("[CodexMcpBridge] listening on " + Prefix);
            }
            catch (Exception ex)
            {
                _running = false;
                Debug.LogError("[CodexMcpBridge] failed to start: " + ex);
            }
        }

        private static void EnsureRunner()
        {
            if (GameObject.Find("CodexMcpBridgeRunner") != null)
                return;

            var go = new GameObject("CodexMcpBridgeRunner");
            UnityEngine.Object.DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideAndDontSave;
            go.AddComponent<BridgeRunner>();
        }

        public static void Pump()
        {
            while (true)
            {
                WorkItem item = null;
                lock (Gate)
                {
                    if (Queue.Count > 0)
                        item = Queue.Dequeue();
                }

                if (item == null)
                    return;

                RunWorkItem(item);
            }
        }

        public static void PumpPending()
        {
            for (var i = Pending.Count - 1; i >= 0; i--)
            {
                var item = Pending[i];
                try
                {
                    if (item.Cancelled)
                    {
                        Pending.RemoveAt(i);
                        continue;
                    }

                    if (DateTime.UtcNow > item.DeadlineUtc)
                    {
                        item.Result = Fail("Bridge command timed out in Unity main-thread awaiter: " + item.Command);
                        item.Cancelled = true;
                        Pending.RemoveAt(i);
                        item.Done.Set();
                        continue;
                    }

                    if (!IsAwaiterCompleted(item.Awaiter))
                        continue;

                    item.Result = Ok(item.GetResult == null ? null : item.GetResult.Invoke(item.Awaiter, null));
                }
                catch (Exception ex)
                {
                    item.Result = Fail(ex.ToString());
                }

                Pending.RemoveAt(i);
                item.Done.Set();
            }
        }

        private static void RunWorkItem(WorkItem item)
        {
            try
            {
                if (item.Cancelled)
                    return;

                if (DateTime.UtcNow > item.DeadlineUtc)
                {
                    item.Result = Fail("Bridge command timed out before Unity main thread processed it: " + item.Command);
                    item.Done.Set();
                    return;
                }

                var result = Dispatch(item.Command, item.Params ?? new JObject());
                if (TrySetPendingAwaiter(item, result))
                {
                    Pending.Add(item);
                    return;
                }

                item.Result = Ok(result);
            }
            catch (Exception ex)
            {
                item.Result = Fail(ex.ToString());
            }
            item.Done.Set();
        }

        private static bool TrySetPendingAwaiter(WorkItem item, object maybeTask)
        {
            if (maybeTask == null)
                return false;

            var awaiterMethod = maybeTask.GetType().GetMethod("GetAwaiter", BindingFlags.Public | BindingFlags.Instance);
            if (awaiterMethod == null)
                return false;

            var awaiter = awaiterMethod.Invoke(maybeTask, null);
            if (awaiter == null)
                return false;

            item.Awaiter = awaiter;
            item.GetResult = awaiter.GetType().GetMethod("GetResult", BindingFlags.Public | BindingFlags.Instance);
            return true;
        }

        private static bool IsAwaiterCompleted(object awaiter)
        {
            if (awaiter == null)
                return true;

            var prop = awaiter.GetType().GetProperty("IsCompleted", BindingFlags.Public | BindingFlags.Instance);
            if (prop == null)
                return true;

            return (bool)prop.GetValue(awaiter, null);
        }
        private static void ListenLoop()
        {
            while (_running)
            {
                try
                {
                    var context = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => Handle(context));
                }
                catch (Exception ex)
                {
                    if (_running)
                        Debug.LogError("[CodexMcpBridge] listen error: " + ex);
                }
            }
        }

        private static void Handle(HttpListenerContext context)
        {
            try
            {
                if (context.Request.Url.AbsolutePath == "/health")
                {
                    Write(context, 200, Ok(new { bridge = "CodexMcpBridge", version = BridgeVersion, dll = true }));
                    return;
                }

                if (context.Request.Url.AbsolutePath != "/command" || context.Request.HttpMethod != "POST")
                {
                    Write(context, 404, Fail("Use POST /command."));
                    return;
                }

                string body;
                using (var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding))
                    body = reader.ReadToEnd();

                var payload = string.IsNullOrWhiteSpace(body) ? new JObject() : JObject.Parse(body);
                var item = new WorkItem
                {
                    Command = Value<string>(payload, "command", ""),
                    Params = payload["params"] as JObject ?? new JObject(),
                    DeadlineUtc = DateTime.UtcNow.AddMilliseconds(BridgeCommandTimeoutMs)
                };

                lock (Gate)
                    Queue.Enqueue(item);

                if (!item.Done.WaitOne(BridgeCommandTimeoutMs + 1000))
                {
                    item.Cancelled = true;
                    item.Result = Fail("Bridge command timed out waiting for Unity main thread: " + item.Command);
                    Write(context, 504, item.Result);
                    return;
                }

                Write(context, 200, item.Result);
            }
            catch (Exception ex)
            {
                Write(context, 500, Fail(ex.ToString()));
            }
        }

        private static object Dispatch(string command, JObject args)
        {
            switch (command)
            {
                case "status":
                    return new
                    {
                        bridge = "CodexMcpBridge",
                        version = BridgeVersion,
                        url = Prefix,
                        dll = true,
                        commandTimeoutMs = BridgeCommandTimeoutMs
                    };
                case "ui.snapshot":
                    return InvokeStatic("Witch.UI.Automation.RuntimeUiAutomationService", "CaptureSnapshot", BuildUiSnapshotRequest(args));
                case "ui.interact":
                    return InvokeStatic("Witch.UI.Automation.RuntimeUiAutomationService", "InteractAsync", BuildUiInteractionRequest(args));
                case "ui.wait":
                    var snapshot = InvokeStatic("Witch.UI.Automation.RuntimeUiAutomationService", "CaptureSnapshot", BuildUiSnapshotRequest(new JObject { ["includeHidden"] = true }));
                    return InvokeStatic("Witch.UI.Automation.RuntimeUiAutomationService", "EvaluateWaitCondition", snapshot, BuildUiWaitRequest(args));
                case "scene.snapshot":
                    return InvokeStatic("Witch.UI.Automation.RuntimeSceneAutomationService", "CaptureSnapshot", BuildSceneSnapshotRequest(args));
                case "scene.raycast":
                    return InvokeStatic("Witch.UI.Automation.RuntimeSceneAutomationService", "Raycast", BuildSceneRaycastRequest(args));
                case "scene.interact":
                    return InvokeStatic("Witch.UI.Automation.RuntimeSceneAutomationService", "InteractAsync", BuildSceneInteractionRequest(args));
                case "screen.info":
                    return ScreenInfo();
                case "screen.capture":
                    return CaptureScreen(args);
                case "window.focus":
                    return FocusWindow();
                case "input.key":
                    return SendKeyInput(args);
                case "input.text":
                    return SendTextInput(args);
                case "input.mouse":
                    return SendMouseInput(args);
                case "game.legal_actions":
                    return InvokeStatic("Witch.UI.Automation.RuntimeGameplayAutomationService", "GetLegalActions");
                case "game.perform_action":
                    return InvokeStatic("Witch.UI.Automation.RuntimeGameplayAutomationService", "PerformActionAsync", BuildPerformActionRequest(args));
                case "battle.snapshot":
                    return CaptureBattleSnapshot(args);
                case "battle.play_card":
                    return InvokeStatic("Witch.UI.Automation.RuntimeBattleAutomationService", "PlayCardAsync", BuildPlayCardRequest(args));
                case "map.place_card":
                    return PlaceMapCard(args);
                case "runtime.inspect":
                    return InspectRuntime(args);
                case "runtime.objects":
                    return InspectRuntimeObjects(args);
                case "runtime.object_detail":
                    return InspectRuntimeObjectDetail(args);
                case "runtime.component_members":
                    return InspectRuntimeComponentMembers(args);
                case "runtime.component_call":
                    return InvokeRuntimeComponent(args);
                case "runtime.component_set":
                    return SetRuntimeComponentMember(args);
                case "runtime.invoke_static":
                    return InvokeRuntimeStatic(args);
                default:
                    throw new InvalidOperationException("Unknown command: " + command);
            }
        }

        private static object InspectRuntime(JObject args)
        {
            var query = Value<string>(args, "query", "");
            var assemblyFilter = Value<string>(args, "assembly", "");
            var includeNonPublic = Value(args, "includeNonPublic", false);
            var includeProperties = Value(args, "includeProperties", true);
            var includeFields = Value(args, "includeFields", false);
            var maxTypes = Math.Max(1, Math.Min(500, Value(args, "maxTypes", 80)));
            var maxMembers = Math.Max(0, Math.Min(100, Value(args, "maxMembersPerType", 30)));
            var types = new List<object>();
            var assemblies = AppDomain.CurrentDomain.GetAssemblies();

            foreach (var assembly in assemblies)
            {
                var assemblyName = assembly.GetName().Name;
                if (!string.IsNullOrWhiteSpace(assemblyFilter) && !ContainsIgnoreCase(assemblyName, assemblyFilter))
                    continue;

                Type[] assemblyTypes;
                try
                {
                    assemblyTypes = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    assemblyTypes = ex.Types;
                }
                catch
                {
                    continue;
                }

                foreach (var type in assemblyTypes)
                {
                    if (type == null)
                        continue;
                    if (!MatchesRuntimeQuery(type, query))
                        continue;

                    types.Add(DescribeType(assemblyName, type, includeNonPublic, includeProperties, includeFields, maxMembers));
                    if (types.Count >= maxTypes)
                    {
                        return new
                        {
                            query,
                            assembly = assemblyFilter,
                            truncated = true,
                            types
                        };
                    }
                }
            }

            return new
            {
                query,
                assembly = assemblyFilter,
                truncated = false,
                types
            };
        }

        private static bool MatchesRuntimeQuery(Type type, string query)
        {
            if (string.IsNullOrWhiteSpace(query))
                return type.FullName != null && type.FullName.StartsWith("Witch.", StringComparison.Ordinal);
            if (ContainsIgnoreCase(type.FullName, query) || ContainsIgnoreCase(type.Name, query))
                return true;
            var flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance;
            foreach (var method in type.GetMethods(flags))
            {
                if (ContainsIgnoreCase(method.Name, query))
                    return true;
            }
            return false;
        }

        private static object DescribeType(string assemblyName, Type type, bool includeNonPublic, bool includeProperties, bool includeFields, int maxMembers)
        {
            var flags = BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
            if (includeNonPublic)
                flags |= BindingFlags.NonPublic;

            var members = new List<object>();
            foreach (var method in type.GetMethods(flags))
            {
                if (method.IsSpecialName)
                    continue;
                members.Add(new
                {
                    kind = "method",
                    name = method.Name,
                    isStatic = method.IsStatic,
                    isPublic = method.IsPublic,
                    returnType = FriendlyTypeName(method.ReturnType),
                    parameters = DescribeParameters(method.GetParameters())
                });
                if (members.Count >= maxMembers)
                    break;
            }

            if (includeProperties && members.Count < maxMembers)
            {
                foreach (var property in type.GetProperties(flags))
                {
                    members.Add(new
                    {
                        kind = "property",
                        name = property.Name,
                        type = FriendlyTypeName(property.PropertyType),
                        canRead = property.CanRead,
                        canWrite = property.CanWrite
                    });
                    if (members.Count >= maxMembers)
                        break;
                }
            }

            if (includeFields && members.Count < maxMembers)
            {
                foreach (var field in type.GetFields(flags))
                {
                    members.Add(new
                    {
                        kind = "field",
                        name = field.Name,
                        isStatic = field.IsStatic,
                        isPublic = field.IsPublic,
                        type = FriendlyTypeName(field.FieldType)
                    });
                    if (members.Count >= maxMembers)
                        break;
                }
            }

            return new
            {
                assembly = assemblyName,
                fullName = type.FullName,
                name = type.Name,
                isPublic = type.IsPublic || type.IsNestedPublic,
                isStatic = type.IsAbstract && type.IsSealed,
                membersTruncated = members.Count >= maxMembers,
                members
            };
        }

        private static object[] DescribeParameters(ParameterInfo[] parameters)
        {
            var result = new object[parameters.Length];
            for (var i = 0; i < parameters.Length; i++)
            {
                result[i] = new
                {
                    name = parameters[i].Name,
                    type = FriendlyTypeName(parameters[i].ParameterType),
                    hasDefault = parameters[i].HasDefaultValue
                };
            }
            return result;
        }

        private static string FriendlyTypeName(Type type)
        {
            if (type == null)
                return "";
            if (!type.IsGenericType)
                return type.FullName ?? type.Name;
            var name = type.FullName ?? type.Name;
            var tick = name.IndexOf('`');
            if (tick >= 0)
                name = name.Substring(0, tick);
            var args = type.GetGenericArguments();
            var parts = new string[args.Length];
            for (var i = 0; i < args.Length; i++)
                parts[i] = FriendlyTypeName(args[i]);
            return name + "<" + string.Join(",", parts) + ">";
        }

        private static object InvokeRuntimeStatic(JObject args)
        {
            var typeName = Value<string>(args, "typeName", "");
            var methodName = Value<string>(args, "methodName", "");
            var allowPrefixes = Values(args["allowPrefixes"] as JArray);
            var invokeArgs = args["arguments"] as JArray ?? new JArray();

            if (string.IsNullOrWhiteSpace(typeName) || string.IsNullOrWhiteSpace(methodName))
                throw new InvalidOperationException("runtime.invoke_static requires typeName and methodName.");
            if (!IsAllowedRuntimeInvoke(typeName, allowPrefixes))
                throw new InvalidOperationException("runtime.invoke_static denied for type: " + typeName);

            var type = FindType(typeName);
            if (type == null)
                throw new InvalidOperationException("Type not found: " + typeName);

            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (method.Name != methodName)
                    continue;
                var parameters = method.GetParameters();
                if (parameters.Length != invokeArgs.Count)
                    continue;
                var converted = ConvertArguments(invokeArgs, parameters);
                var result = method.Invoke(null, converted);
                return new
                {
                    typeName = type.FullName,
                    methodName,
                    result
                };
            }

            throw new MissingMethodException(typeName, methodName);
        }

        private static bool IsAllowedRuntimeInvoke(string typeName, string[] allowPrefixes)
        {
            if (typeName.StartsWith("Witch.UI.Automation.", StringComparison.Ordinal))
                return true;
            for (var i = 0; i < allowPrefixes.Length; i++)
            {
                var prefix = allowPrefixes[i];
                if (!string.IsNullOrWhiteSpace(prefix) && typeName.StartsWith(prefix, StringComparison.Ordinal))
                    return true;
            }
            return false;
        }

        private static object[] ConvertArguments(JArray values, ParameterInfo[] parameters)
        {
            var converted = new object[parameters.Length];
            for (var i = 0; i < parameters.Length; i++)
                converted[i] = ConvertToken(values[i], parameters[i].ParameterType);
            return converted;
        }

        private static object ConvertToken(JToken token, Type targetType)
        {
            if (token == null || token.Type == JTokenType.Null)
                return null;

            var nullable = Nullable.GetUnderlyingType(targetType);
            if (nullable != null)
                targetType = nullable;

            if (targetType == typeof(string))
                return token.Value<string>();
            if (targetType == typeof(bool))
                return token.Value<bool>();
            if (targetType == typeof(int))
                return token.Value<int>();
            if (targetType == typeof(long))
                return token.Value<long>();
            if (targetType == typeof(float))
                return token.Value<float>();
            if (targetType == typeof(double))
                return token.Value<double>();
            if (targetType.IsEnum)
                return Enum.Parse(targetType, token.Value<string>(), true);
            if (token.Type == JTokenType.Object)
                return token.ToObject(targetType);
            if (token.Type == JTokenType.Array)
                return token.ToObject(targetType);

            return Convert.ChangeType(((JValue)token).Value, targetType);
        }

        private static bool ContainsIgnoreCase(string value, string query)
        {
            if (value == null || query == null)
                return false;
            return value.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static object InspectRuntimeObjects(JObject args)
        {
            var query = Value<string>(args, "query", "");
            var componentType = Value<string>(args, "componentType", "");
            var tag = Value<string>(args, "tag", "");
            var layerName = Value<string>(args, "layerName", "");
            var includeInactive = Value(args, "includeInactive", false);
            var includeComponents = Value(args, "includeComponents", true);
            var includeBounds = Value(args, "includeBounds", true);
            var maxObjects = Math.Max(1, Math.Min(1000, Value(args, "maxObjects", 100)));
            var camera = Camera.main;
            var objects = new List<object>();

            foreach (var go in FindGameObjects(includeInactive))
            {
                if (go == null)
                    continue;
                if (!includeInactive && !go.activeInHierarchy)
                    continue;
                if (!MatchesObjectQuery(go, query, componentType, tag, layerName))
                    continue;

                objects.Add(DescribeGameObject(go, camera, includeComponents, includeBounds));
                if (objects.Count >= maxObjects)
                    return new
                    {
                        query,
                        componentType,
                        tag,
                        layerName,
                        includeInactive,
                        truncated = true,
                        objects
                    };
            }

            return new
            {
                query,
                componentType,
                tag,
                layerName,
                includeInactive,
                truncated = false,
                objects
            };
        }

        private static object InspectRuntimeObjectDetail(JObject args)
        {
            var includeInactive = Value(args, "includeInactive", true);
            var includeFields = Value(args, "includeFields", false);
            var includeProperties = Value(args, "includeProperties", true);
            var componentType = Value<string>(args, "componentType", "");
            var maxMembersPerComponent = Math.Max(0, Math.Min(200, Value(args, "maxMembersPerComponent", 40)));
            var maxStringLength = Math.Max(32, Math.Min(4096, Value(args, "maxStringLength", 500)));
            var go = FindGameObject(args, includeInactive);

            if (go == null)
                return new { found = false, selector = args };

            var camera = Camera.main;
            var componentDetails = new List<object>();
            var components = go.GetComponents<UnityEngine.Component>();
            for (var i = 0; i < components.Length; i++)
            {
                var component = components[i];
                if (component == null)
                    continue;
                var type = component.GetType();
                if (!string.IsNullOrWhiteSpace(componentType) && !ContainsIgnoreCase(type.Name, componentType) && !ContainsIgnoreCase(type.FullName, componentType))
                    continue;
                componentDetails.Add(DescribeComponentDetail(component, includeProperties, includeFields, maxMembersPerComponent, maxStringLength));
            }

            return new
            {
                found = true,
                gameObject = DescribeGameObject(go, camera, false, true),
                components = componentDetails
            };
        }

        private static object PlaceMapCard(JObject args)
        {
            var dryRun = Value(args, "dryRun", true);
            var confirm = Value<string>(args, "confirm", "");
            if (!dryRun && confirm != "PLACE_WITCH_MAP_CARD")
                throw new InvalidOperationException("map.place_card requires confirm=PLACE_WITCH_MAP_CARD when dryRun is false.");

            var card = FindMapComponent(args, "card", "MapItem");
            var slot = FindMapComponent(args, "slot", "SwapContentIdentity");
            var content = slot == null ? null : ReadTransformMember(slot, "Content");
            var before = DescribeMapSlotFill(slot, content);
            if (card == null || slot == null)
            {
                return new
                {
                    ok = false,
                    dryRun,
                    reason = card == null ? "map_card_not_found" : "map_slot_not_found",
                    selector = args,
                    selectedCard = DescribeMapComponent(card),
                    selectedSlot = DescribeMapComponent(slot),
                    slotFill = before
                };
            }

            var addToList = SelectSingleArgumentMethod(card.GetType(), "AddToList", slot.GetType());
            var removeFromParent = SelectNoArgumentMethod(card.GetType(), "RemoveFromParent");
            var dataUpdate = SelectNoArgumentMethod(card.GetType(), "DataUpdate");
            var selected = new
            {
                ok = true,
                dryRun,
                selectedCard = DescribeMapComponent(card),
                selectedSlot = DescribeMapComponent(slot),
                slotFillBefore = before,
                method = addToList == null ? null : DescribeMethod(addToList),
                removeMethod = removeFromParent == null ? null : DescribeMethod(removeFromParent),
                dataUpdateMethod = dataUpdate == null ? null : DescribeMethod(dataUpdate)
            };
            if (dryRun)
                return selected;
            if (addToList == null)
                return new
                {
                    ok = false,
                    dryRun,
                    reason = "map_card_add_to_list_method_not_found",
                    selectedCard = selected.selectedCard,
                    selectedSlot = selected.selectedSlot,
                    slotFillBefore = before
                };

            object invokeResult = null;
            try
            {
                if (removeFromParent != null)
                    removeFromParent.Invoke(card, new object[0]);
                invokeResult = addToList.Invoke(card, new object[] { slot });
                if (dataUpdate != null)
                    dataUpdate.Invoke(card, new object[0]);
            }
            catch (TargetInvocationException ex)
            {
                var inner = ex.InnerException ?? ex;
                return new
                {
                    ok = false,
                    dryRun,
                    reason = "map_card_place_invocation_failed",
                    error = inner.GetType().Name,
                    message = Truncate(inner.Message, 1000),
                    selectedCard = selected.selectedCard,
                    selectedSlot = selected.selectedSlot,
                    slotFillBefore = before,
                    slotFillAfter = DescribeMapSlotFill(slot, content)
                };
            }

            var after = DescribeMapSlotFill(slot, content);
            return new
            {
                ok = after.filled,
                dryRun,
                reason = after.filled ? null : "map_place_unverified_slot_not_filled",
                selectedCard = selected.selectedCard,
                selectedSlot = selected.selectedSlot,
                slotFillBefore = before,
                slotFillAfter = after,
                result = SafeValue(invokeResult, addToList.ReturnType, 500)
            };
        }

        private static UnityEngine.Component FindMapComponent(JObject args, string prefix, string componentType)
        {
            var instanceId = NullableInt(args, prefix + "InstanceId");
            var objectInstanceId = NullableInt(args, prefix + "ObjectInstanceId");
            var path = Value<string>(args, prefix + "Path", "");
            var label = Value<string>(args, prefix + "Label", "");
            var index = NullableInt(args, prefix + "Index");
            var includeInactive = Value(args, "includeInactive", true);
            var foundIndex = 0;
            foreach (var component in FindComponents(includeInactive))
            {
                if (component == null)
                    continue;
                var go = component.gameObject;
                if (go == null)
                    continue;
                var type = component.GetType();
                if (!ContainsIgnoreCase(type.Name, componentType) && !ContainsIgnoreCase(type.FullName, componentType))
                    continue;
                if (instanceId.HasValue && component.GetInstanceID() != instanceId.Value)
                    continue;
                if (objectInstanceId.HasValue && go.GetInstanceID() != objectInstanceId.Value)
                    continue;
                if (!string.IsNullOrWhiteSpace(path) && !string.Equals(TransformPath(go.transform), path, StringComparison.Ordinal))
                    continue;
                if (!string.IsNullOrWhiteSpace(label) && !MapComponentMatchesLabel(component, label))
                    continue;
                if (index.HasValue && foundIndex != index.Value)
                {
                    foundIndex++;
                    continue;
                }
                return component;
            }
            return null;
        }

        private static bool MapComponentMatchesLabel(UnityEngine.Component component, string label)
        {
            if (component == null || string.IsNullOrWhiteSpace(label))
                return true;
            if (ContainsIgnoreCase(component.gameObject.name, label) || ContainsIgnoreCase(TransformPath(component.gameObject.transform), label))
                return true;
            var values = ReadNamedValues(component, new[] { "Id", "id", "Name", "name", "Title", "title", "Text", "text", "Label", "label" }, 300);
            var data = ReadNestedNamedValues(component, new[] { "DataConfig", "dataConfig", "data", "Data", "node", "Node", "node1", "Node1" }, new[] { "Id", "id", "Name", "name", "Title", "title", "Text", "text", "Label", "label" }, 300);
            return DictionaryContainsValue(values, label) || DictionaryContainsValue(data, label);
        }

        private static bool DictionaryContainsValue(Dictionary<string, object> values, string query)
        {
            if (values == null || string.IsNullOrWhiteSpace(query))
                return false;
            foreach (var item in values)
            {
                var text = item.Value == null ? "" : JsonConvert.SerializeObject(item.Value);
                if (ContainsIgnoreCase(text, query))
                    return true;
            }
            return false;
        }

        private static MethodInfo SelectSingleArgumentMethod(Type type, string methodName, Type argumentType)
        {
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!string.Equals(method.Name, methodName, StringComparison.OrdinalIgnoreCase))
                    continue;
                var parameters = method.GetParameters();
                if (parameters.Length != 1)
                    continue;
                if (argumentType == null || parameters[0].ParameterType.IsAssignableFrom(argumentType) || parameters[0].ParameterType.Name == argumentType.Name)
                    return method;
            }
            return null;
        }

        private static MethodInfo SelectNoArgumentMethod(Type type, string methodName)
        {
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!string.Equals(method.Name, methodName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (method.GetParameters().Length == 0)
                    return method;
            }
            return null;
        }

        private static Transform ReadTransformMember(UnityEngine.Component component, string memberName)
        {
            if (component == null)
                return null;
            var type = component.GetType();
            var prop = type.GetProperty(memberName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (prop != null && prop.CanRead && prop.GetIndexParameters().Length == 0)
                return prop.GetValue(component, null) as Transform;
            var field = type.GetField(memberName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (field != null)
                return field.GetValue(component) as Transform;
            return null;
        }

        private static object DescribeMapComponent(UnityEngine.Component component)
        {
            if (component == null)
                return null;
            return new
            {
                instanceId = component.GetInstanceID(),
                objectInstanceId = component.gameObject.GetInstanceID(),
                name = component.gameObject.name,
                componentType = component.GetType().FullName,
                path = TransformPath(component.gameObject.transform),
                activeInHierarchy = component.gameObject.activeInHierarchy
            };
        }

        private static MapSlotFill DescribeMapSlotFill(UnityEngine.Component slot, Transform content)
        {
            if (slot == null)
                return new MapSlotFill { ok = false, filled = false, reason = "slot_missing" };
            if (content == null)
                content = ReadTransformMember(slot, "Content");
            if (content == null)
                return new MapSlotFill { ok = false, filled = false, reason = "slot_content_missing", slot = DescribeMapComponent(slot) };

            var children = new List<object>();
            for (var i = 0; i < content.childCount; i++)
            {
                var child = content.GetChild(i);
                if (child == null || string.Equals(child.name, "Null", StringComparison.OrdinalIgnoreCase))
                    continue;
                children.Add(new
                {
                    name = child.name,
                    instanceId = child.gameObject.GetInstanceID(),
                    path = TransformPath(child),
                    activeSelf = child.gameObject.activeSelf,
                    activeInHierarchy = child.gameObject.activeInHierarchy
                });
            }
            return new MapSlotFill
            {
                ok = true,
                filled = children.Count > 0,
                contentPath = TransformPath(content),
                childCount = children.Count,
                children = children
            };
        }

        private static object InvokeRuntimeComponent(JObject args)
        {
            var includeInactive = Value(args, "includeInactive", true);
            var componentType = Value<string>(args, "componentType", "");
            var methodName = Value<string>(args, "methodName", "");
            var dryRun = Value(args, "dryRun", true);
            var confirm = Value<string>(args, "confirm", "");
            var invokeArgs = args["arguments"] as JArray ?? new JArray();
            var maxStringLength = Math.Max(32, Math.Min(4096, Value(args, "maxStringLength", 500)));

            if (string.IsNullOrWhiteSpace(componentType) || string.IsNullOrWhiteSpace(methodName))
                throw new InvalidOperationException("runtime.component_call requires componentType and methodName.");
            if (!dryRun && confirm != "CALL_WITCH_COMPONENT_METHOD")
                throw new InvalidOperationException("runtime.component_call requires confirm=CALL_WITCH_COMPONENT_METHOD when dryRun is false.");

            var go = FindGameObject(args, includeInactive);
            if (go == null)
                return new { found = false, reason = "object_not_found", dryRun, selector = args };

            var components = go.GetComponents<UnityEngine.Component>();
            var componentCandidates = new List<object>();
            for (var i = 0; i < components.Length; i++)
            {
                var component = components[i];
                if (component == null)
                    continue;
                var type = component.GetType();
                if (!ContainsIgnoreCase(type.Name, componentType) && !ContainsIgnoreCase(type.FullName, componentType))
                    continue;

                var methodCandidates = DescribeCallableMethods(type, methodName, invokeArgs.Count);
                componentCandidates.Add(new
                {
                    type = type.FullName,
                    name = type.Name,
                    enabled = ComponentEnabled(component),
                    methods = methodCandidates
                });

                var method = SelectComponentMethod(type, methodName, invokeArgs.Count);
                if (method == null)
                    continue;

                var selected = new
                {
                    found = true,
                    dryRun,
                    gameObject = DescribeGameObject(go, Camera.main, false, true),
                    component = new { type = type.FullName, name = type.Name, enabled = ComponentEnabled(component) },
                    method = DescribeMethod(method)
                };
                if (dryRun)
                    return selected;

                try
                {
                    var converted = ConvertArguments(invokeArgs, method.GetParameters());
                    var result = method.Invoke(component, converted);
                    return new
                    {
                        found = true,
                        dryRun,
                        gameObject = selected.gameObject,
                        component = selected.component,
                        method = selected.method,
                        result = SafeValue(result, method.ReturnType, maxStringLength)
                    };
                }
                catch (TargetInvocationException ex)
                {
                    var inner = ex.InnerException ?? ex;
                    return new
                    {
                        found = true,
                        dryRun,
                        gameObject = selected.gameObject,
                        component = selected.component,
                        method = selected.method,
                        error = inner.GetType().Name,
                        message = Truncate(inner.Message, maxStringLength)
                    };
                }
            }

            return new
            {
                found = false,
                reason = componentCandidates.Count == 0 ? "component_not_found" : "method_not_found",
                dryRun,
                gameObject = DescribeGameObject(go, Camera.main, true, true),
                componentType,
                methodName,
                argumentCount = invokeArgs.Count,
                candidates = componentCandidates
            };
        }

        private static object InspectRuntimeComponentMembers(JObject args)
        {
            var includeInactive = Value(args, "includeInactive", true);
            var componentType = Value<string>(args, "componentType", "");
            var memberQuery = Value<string>(args, "memberQuery", "");
            var includeMethods = Value(args, "includeMethods", true);
            var includeProperties = Value(args, "includeProperties", true);
            var includeFields = Value(args, "includeFields", true);
            var includeValues = Value(args, "includeValues", false);
            var maxMembersPerComponent = Math.Max(1, Math.Min(500, Value(args, "maxMembersPerComponent", 120)));
            var maxStringLength = Math.Max(32, Math.Min(4096, Value(args, "maxStringLength", 500)));

            if (string.IsNullOrWhiteSpace(componentType))
                throw new InvalidOperationException("runtime.component_members requires componentType.");

            var go = FindGameObject(args, includeInactive);
            if (go == null)
                return new { found = false, reason = "object_not_found", selector = args };

            var components = go.GetComponents<UnityEngine.Component>();
            var results = new List<object>();
            for (var i = 0; i < components.Length; i++)
            {
                var component = components[i];
                if (component == null)
                    continue;
                var type = component.GetType();
                if (!ContainsIgnoreCase(type.Name, componentType) && !ContainsIgnoreCase(type.FullName, componentType))
                    continue;
                results.Add(DescribeComponentMembers(component, memberQuery, includeMethods, includeProperties, includeFields, includeValues, maxMembersPerComponent, maxStringLength));
            }

            return new
            {
                found = true,
                gameObject = DescribeGameObject(go, Camera.main, false, true),
                componentType,
                memberQuery,
                components = results
            };
        }

        private static object SetRuntimeComponentMember(JObject args)
        {
            var includeInactive = Value(args, "includeInactive", true);
            var componentType = Value<string>(args, "componentType", "");
            var memberName = Value<string>(args, "memberName", "");
            var memberKind = Value<string>(args, "memberKind", "");
            var dryRun = Value(args, "dryRun", true);
            var confirm = Value<string>(args, "confirm", "");
            var valueToken = args["value"];
            var maxStringLength = Math.Max(32, Math.Min(4096, Value(args, "maxStringLength", 500)));

            if (string.IsNullOrWhiteSpace(componentType) || string.IsNullOrWhiteSpace(memberName))
                throw new InvalidOperationException("runtime.component_set requires componentType and memberName.");
            if (valueToken == null)
                throw new InvalidOperationException("runtime.component_set requires value.");
            if (!dryRun && confirm != "SET_WITCH_COMPONENT_MEMBER")
                throw new InvalidOperationException("runtime.component_set requires confirm=SET_WITCH_COMPONENT_MEMBER when dryRun is false.");

            var go = FindGameObject(args, includeInactive);
            if (go == null)
                return new { found = false, reason = "object_not_found", dryRun, selector = args };

            var components = go.GetComponents<UnityEngine.Component>();
            var candidates = new List<object>();
            for (var i = 0; i < components.Length; i++)
            {
                var component = components[i];
                if (component == null)
                    continue;
                var type = component.GetType();
                if (!ContainsIgnoreCase(type.Name, componentType) && !ContainsIgnoreCase(type.FullName, componentType))
                    continue;

                var prop = FindWritableProperty(type, memberName);
                var field = FindWritableField(type, memberName);
                candidates.Add(new
                {
                    type = type.FullName,
                    name = type.Name,
                    enabled = ComponentEnabled(component),
                    writable = DescribeWritableMembers(prop, field)
                });

                if ((string.IsNullOrWhiteSpace(memberKind) || EqualsIgnoreCase(memberKind, "property")) && prop != null)
                    return SetRuntimeProperty(go, component, prop, valueToken, dryRun, maxStringLength);
                if ((string.IsNullOrWhiteSpace(memberKind) || EqualsIgnoreCase(memberKind, "field")) && field != null)
                    return SetRuntimeField(go, component, field, valueToken, dryRun, maxStringLength);
            }

            return new
            {
                found = false,
                reason = candidates.Count == 0 ? "component_not_found" : "member_not_found_or_not_writable",
                dryRun,
                gameObject = DescribeGameObject(go, Camera.main, true, true),
                componentType,
                memberName,
                memberKind,
                candidates
            };
        }

        private static object SetRuntimeProperty(GameObject go, UnityEngine.Component component, PropertyInfo prop, JToken valueToken, bool dryRun, int maxStringLength)
        {
            object before = null;
            try
            {
                if (prop.CanRead)
                    before = SafeValue(prop.GetValue(component, null), prop.PropertyType, maxStringLength);
            }
            catch
            {
            }

            var converted = ConvertToken(valueToken, prop.PropertyType);
            var member = DescribeWritableProperty(prop);
            if (dryRun)
                return new
                {
                    found = true,
                    dryRun,
                    gameObject = DescribeGameObject(go, Camera.main, false, true),
                    component = DescribeComponentIdentity(component),
                    member,
                    before,
                    requestedValue = SafeValue(converted, prop.PropertyType, maxStringLength)
                };

            prop.SetValue(component, converted, null);
            return new
            {
                found = true,
                dryRun,
                gameObject = DescribeGameObject(go, Camera.main, false, true),
                component = DescribeComponentIdentity(component),
                member,
                before,
                after = ReadMemberValue(() => prop.GetValue(component, null), prop.PropertyType, maxStringLength)
            };
        }

        private static object SetRuntimeField(GameObject go, UnityEngine.Component component, FieldInfo field, JToken valueToken, bool dryRun, int maxStringLength)
        {
            object before = null;
            try
            {
                before = SafeValue(field.GetValue(component), field.FieldType, maxStringLength);
            }
            catch
            {
            }

            var converted = ConvertToken(valueToken, field.FieldType);
            var member = DescribeWritableField(field);
            if (dryRun)
                return new
                {
                    found = true,
                    dryRun,
                    gameObject = DescribeGameObject(go, Camera.main, false, true),
                    component = DescribeComponentIdentity(component),
                    member,
                    before,
                    requestedValue = SafeValue(converted, field.FieldType, maxStringLength)
                };

            field.SetValue(component, converted);
            return new
            {
                found = true,
                dryRun,
                gameObject = DescribeGameObject(go, Camera.main, false, true),
                component = DescribeComponentIdentity(component),
                member,
                before,
                after = ReadMemberValue(() => field.GetValue(component), field.FieldType, maxStringLength)
            };
        }

        private static MethodInfo SelectComponentMethod(Type type, string methodName, int argumentCount)
        {
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (method.IsSpecialName)
                    continue;
                if (!string.Equals(method.Name, methodName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (method.GetParameters().Length != argumentCount)
                    continue;
                return method;
            }
            return null;
        }

        private static List<object> DescribeCallableMethods(Type type, string methodName, int argumentCount)
        {
            var methods = new List<object>();
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (method.IsSpecialName)
                    continue;
                if (!string.Equals(method.Name, methodName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (method.GetParameters().Length != argumentCount)
                    continue;
                methods.Add(DescribeMethod(method));
            }
            return methods;
        }

        private static object DescribeMethod(MethodInfo method)
        {
            var parameters = method.GetParameters();
            var described = new List<object>();
            for (var i = 0; i < parameters.Length; i++)
            {
                described.Add(new
                {
                    name = parameters[i].Name,
                    type = FriendlyTypeName(parameters[i].ParameterType),
                    optional = parameters[i].IsOptional
                });
            }
            return new
            {
                name = method.Name,
                declaringType = FriendlyTypeName(method.DeclaringType),
                returnType = FriendlyTypeName(method.ReturnType),
                parameters = described
            };
        }

        private static object DescribeComponentMembers(UnityEngine.Component component, string memberQuery, bool includeMethods, bool includeProperties, bool includeFields, bool includeValues, int maxMembers, int maxStringLength)
        {
            var type = component.GetType();
            var members = new List<object>();
            var flags = BindingFlags.Public | BindingFlags.Instance;

            if (includeProperties)
            {
                foreach (var prop in type.GetProperties(flags))
                {
                    if (prop.GetIndexParameters().Length != 0)
                        continue;
                    if (!MatchesMemberQuery(prop.Name, memberQuery))
                        continue;
                    var item = new Dictionary<string, object>();
                    item["kind"] = "property";
                    item["name"] = prop.Name;
                    item["declaringType"] = FriendlyTypeName(prop.DeclaringType);
                    item["type"] = FriendlyTypeName(prop.PropertyType);
                    item["readable"] = prop.CanRead;
                    item["writable"] = prop.CanWrite && prop.GetSetMethod(false) != null;
                    if (includeValues && prop.CanRead)
                        item["value"] = ReadMemberValue(() => prop.GetValue(component, null), prop.PropertyType, maxStringLength);
                    members.Add(item);
                    if (members.Count >= maxMembers)
                        return DescribeComponentMembersResult(component, members, true);
                }
            }

            if (includeFields)
            {
                foreach (var field in type.GetFields(flags))
                {
                    if (!MatchesMemberQuery(field.Name, memberQuery))
                        continue;
                    var item = new Dictionary<string, object>();
                    item["kind"] = "field";
                    item["name"] = field.Name;
                    item["declaringType"] = FriendlyTypeName(field.DeclaringType);
                    item["type"] = FriendlyTypeName(field.FieldType);
                    item["readable"] = true;
                    item["writable"] = !field.IsInitOnly && !field.IsLiteral;
                    if (includeValues)
                        item["value"] = ReadMemberValue(() => field.GetValue(component), field.FieldType, maxStringLength);
                    members.Add(item);
                    if (members.Count >= maxMembers)
                        return DescribeComponentMembersResult(component, members, true);
                }
            }

            if (includeMethods)
            {
                foreach (var method in type.GetMethods(flags))
                {
                    if (method.IsSpecialName)
                        continue;
                    if (!MatchesMemberQuery(method.Name, memberQuery))
                        continue;
                    members.Add(DescribeMethod(method));
                    if (members.Count >= maxMembers)
                        return DescribeComponentMembersResult(component, members, true);
                }
            }

            return DescribeComponentMembersResult(component, members, false);
        }

        private static object DescribeComponentMembersResult(UnityEngine.Component component, List<object> members, bool truncated)
        {
            var type = component.GetType();
            return new
            {
                type = type.FullName,
                name = type.Name,
                enabled = ComponentEnabled(component),
                membersTruncated = truncated,
                members
            };
        }

        private static bool MatchesMemberQuery(string name, string query)
        {
            return string.IsNullOrWhiteSpace(query) || ContainsIgnoreCase(name, query);
        }

        private static PropertyInfo FindWritableProperty(Type type, string memberName)
        {
            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!string.Equals(prop.Name, memberName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (!prop.CanWrite || prop.GetSetMethod(false) == null || prop.GetIndexParameters().Length != 0)
                    continue;
                return prop;
            }
            return null;
        }

        private static FieldInfo FindWritableField(Type type, string memberName)
        {
            foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!string.Equals(field.Name, memberName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (field.IsInitOnly || field.IsLiteral)
                    continue;
                return field;
            }
            return null;
        }

        private static List<object> DescribeWritableMembers(PropertyInfo prop, FieldInfo field)
        {
            var members = new List<object>();
            if (prop != null)
                members.Add(DescribeWritableProperty(prop));
            if (field != null)
                members.Add(DescribeWritableField(field));
            return members;
        }

        private static object DescribeWritableProperty(PropertyInfo prop)
        {
            return new
            {
                kind = "property",
                name = prop.Name,
                declaringType = FriendlyTypeName(prop.DeclaringType),
                type = FriendlyTypeName(prop.PropertyType),
                readable = prop.CanRead,
                writable = true
            };
        }

        private static object DescribeWritableField(FieldInfo field)
        {
            return new
            {
                kind = "field",
                name = field.Name,
                declaringType = FriendlyTypeName(field.DeclaringType),
                type = FriendlyTypeName(field.FieldType),
                readable = true,
                writable = true
            };
        }

        private static object DescribeComponentIdentity(UnityEngine.Component component)
        {
            var type = component.GetType();
            return new { type = type.FullName, name = type.Name, enabled = ComponentEnabled(component) };
        }

        private static GameObject FindGameObject(JObject args, bool includeInactive)
        {
            var instanceId = NullableInt(args, "instanceId");
            var path = Value<string>(args, "path", "");
            var name = Value<string>(args, "name", "");
            var query = Value<string>(args, "query", "");
            foreach (var go in FindGameObjects(includeInactive))
            {
                if (go == null)
                    continue;
                if (!includeInactive && !go.activeInHierarchy)
                    continue;
                if (instanceId.HasValue && go.GetInstanceID() == instanceId.Value)
                    return go;
                if (!string.IsNullOrWhiteSpace(path) && string.Equals(TransformPath(go.transform), path, StringComparison.Ordinal))
                    return go;
                if (!string.IsNullOrWhiteSpace(name) && string.Equals(go.name, name, StringComparison.OrdinalIgnoreCase))
                    return go;
                if (!string.IsNullOrWhiteSpace(query) && (ContainsIgnoreCase(go.name, query) || ContainsIgnoreCase(TransformPath(go.transform), query)))
                    return go;
            }
            return null;
        }

        private static object DescribeComponentDetail(UnityEngine.Component component, bool includeProperties, bool includeFields, int maxMembers, int maxStringLength)
        {
            var type = component.GetType();
            var members = new List<object>();
            var flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly;

            if (includeProperties)
            {
                foreach (var prop in type.GetProperties(flags))
                {
                    if (!prop.CanRead || prop.GetIndexParameters().Length != 0)
                        continue;
                    members.Add(new
                    {
                        kind = "property",
                        name = prop.Name,
                        type = FriendlyTypeName(prop.PropertyType),
                        value = ReadMemberValue(() => prop.GetValue(component, null), prop.PropertyType, maxStringLength)
                    });
                    if (members.Count >= maxMembers)
                        break;
                }
            }

            if (includeFields && members.Count < maxMembers)
            {
                foreach (var field in type.GetFields(flags))
                {
                    members.Add(new
                    {
                        kind = "field",
                        name = field.Name,
                        type = FriendlyTypeName(field.FieldType),
                        value = ReadMemberValue(() => field.GetValue(component), field.FieldType, maxStringLength)
                    });
                    if (members.Count >= maxMembers)
                        break;
                }
            }

            return new
            {
                type = type.FullName,
                name = type.Name,
                enabled = ComponentEnabled(component),
                membersTruncated = members.Count >= maxMembers,
                members
            };
        }

        private delegate object ValueReader();

        private static object ReadMemberValue(ValueReader reader, Type valueType, int maxStringLength)
        {
            try
            {
                var value = reader();
                return SafeValue(value, valueType, maxStringLength);
            }
            catch (Exception ex)
            {
                return new { error = ex.GetType().Name, message = Truncate(ex.Message, maxStringLength) };
            }
        }

        private static object SafeValue(object value, Type valueType, int maxStringLength)
        {
            if (value == null)
                return null;
            var type = valueType ?? value.GetType();
            var nullable = Nullable.GetUnderlyingType(type);
            if (nullable != null)
                type = nullable;
            if (type == typeof(string))
                return Truncate((string)value, maxStringLength);
            if (type.IsPrimitive || type.IsEnum || type == typeof(decimal))
                return value;
            if (type == typeof(Vector2))
            {
                var v = (Vector2)value;
                return new { x = v.x, y = v.y };
            }
            if (type == typeof(Vector3))
            {
                var v = (Vector3)value;
                return new { x = v.x, y = v.y, z = v.z };
            }
            if (type == typeof(Vector4))
            {
                var v = (Vector4)value;
                return new { x = v.x, y = v.y, z = v.z, w = v.w };
            }
            if (type == typeof(Quaternion))
            {
                var v = (Quaternion)value;
                return new { x = v.x, y = v.y, z = v.z, w = v.w };
            }
            if (type == typeof(Color))
            {
                var v = (Color)value;
                return new { r = v.r, g = v.g, b = v.b, a = v.a };
            }
            if (type == typeof(Rect))
            {
                var v = (Rect)value;
                return new { x = v.x, y = v.y, width = v.width, height = v.height };
            }
            if (type == typeof(Bounds))
            {
                var v = (Bounds)value;
                return new
                {
                    center = new { x = v.center.x, y = v.center.y, z = v.center.z },
                    size = new { x = v.size.x, y = v.size.y, z = v.size.z }
                };
            }
            var unityObject = value as UnityEngine.Object;
            if (unityObject != null)
                return new { unityObject = true, type = unityObject.GetType().FullName, name = unityObject.name, instanceId = unityObject.GetInstanceID() };
            return new { type = type.FullName, text = Truncate(value.ToString(), maxStringLength) };
        }

        private static string Truncate(string value, int maxLength)
        {
            if (value == null)
                return null;
            if (value.Length <= maxLength)
                return value;
            return value.Substring(0, maxLength) + "...";
        }

        private static GameObject[] FindGameObjects(bool includeInactive)
        {
            try
            {
                var method = typeof(UnityEngine.Object).GetMethod("FindObjectsOfType", new[] { typeof(bool) });
                if (method != null)
                {
                    var generic = method.MakeGenericMethod(typeof(GameObject));
                    var result = generic.Invoke(null, new object[] { includeInactive });
                    return result as GameObject[] ?? new GameObject[0];
                }
            }
            catch
            {
            }

            return UnityEngine.Object.FindObjectsOfType<GameObject>();
        }

        private static bool MatchesObjectQuery(GameObject go, string query, string componentType, string tag, string layerName)
        {
            if (!string.IsNullOrWhiteSpace(query) && !ContainsIgnoreCase(go.name, query) && !ContainsIgnoreCase(TransformPath(go.transform), query))
                return false;
            if (!string.IsNullOrWhiteSpace(tag) && !EqualsIgnoreCase(go.tag, tag))
                return false;
            if (!string.IsNullOrWhiteSpace(layerName) && !EqualsIgnoreCase(LayerMask.LayerToName(go.layer), layerName))
                return false;
            if (!string.IsNullOrWhiteSpace(componentType) && !HasComponentType(go, componentType))
                return false;
            return true;
        }

        private static bool HasComponentType(GameObject go, string componentType)
        {
            var components = go.GetComponents<UnityEngine.Component>();
            for (var i = 0; i < components.Length; i++)
            {
                var component = components[i];
                if (component == null)
                    continue;
                var type = component.GetType();
                if (ContainsIgnoreCase(type.Name, componentType) || ContainsIgnoreCase(type.FullName, componentType))
                    return true;
            }
            return false;
        }

        private static object DescribeGameObject(GameObject go, Camera camera, bool includeComponents, bool includeBounds)
        {
            object[] components = new object[0];
            if (includeComponents)
            {
                var raw = go.GetComponents<UnityEngine.Component>();
                components = new object[raw.Length];
                for (var i = 0; i < raw.Length; i++)
                {
                    var component = raw[i];
                    components[i] = component == null ? null : new
                    {
                        type = component.GetType().FullName,
                        name = component.GetType().Name,
                        enabled = ComponentEnabled(component)
                    };
                }
            }

            object screenPoint = null;
            object screenRect = null;
            var renderer = go.GetComponent<UnityEngine.Renderer>();
            if (camera != null)
            {
                var point = camera.WorldToScreenPoint(go.transform.position);
                screenPoint = new { x = point.x, y = point.y, z = point.z };
                if (includeBounds && renderer != null)
                    screenRect = BoundsToScreenRect(renderer.bounds, camera);
            }

            return new
            {
                name = go.name,
                instanceId = go.GetInstanceID(),
                path = TransformPath(go.transform),
                activeSelf = go.activeSelf,
                activeInHierarchy = go.activeInHierarchy,
                tag = go.tag,
                layer = go.layer,
                layerName = LayerMask.LayerToName(go.layer),
                scene = go.scene.name,
                position = new { x = go.transform.position.x, y = go.transform.position.y, z = go.transform.position.z },
                screenPoint,
                screenRect,
                components
            };
        }

        private static object BoundsToScreenRect(Bounds bounds, Camera camera)
        {
            var center = bounds.center;
            var ext = bounds.extents;
            var points = new[]
            {
                center + new Vector3(-ext.x, -ext.y, -ext.z),
                center + new Vector3(-ext.x, -ext.y, ext.z),
                center + new Vector3(-ext.x, ext.y, -ext.z),
                center + new Vector3(-ext.x, ext.y, ext.z),
                center + new Vector3(ext.x, -ext.y, -ext.z),
                center + new Vector3(ext.x, -ext.y, ext.z),
                center + new Vector3(ext.x, ext.y, -ext.z),
                center + new Vector3(ext.x, ext.y, ext.z)
            };
            var minX = float.PositiveInfinity;
            var minY = float.PositiveInfinity;
            var maxX = float.NegativeInfinity;
            var maxY = float.NegativeInfinity;
            for (var i = 0; i < points.Length; i++)
            {
                var p = camera.WorldToScreenPoint(points[i]);
                minX = Math.Min(minX, p.x);
                minY = Math.Min(minY, p.y);
                maxX = Math.Max(maxX, p.x);
                maxY = Math.Max(maxY, p.y);
            }
            return new { x = minX, y = minY, width = maxX - minX, height = maxY - minY };
        }

        private static bool? ComponentEnabled(UnityEngine.Component component)
        {
            var behaviour = component as UnityEngine.Behaviour;
            if (behaviour != null)
                return behaviour.enabled;
            var renderer = component as UnityEngine.Renderer;
            if (renderer != null)
                return renderer.enabled;
            var enabledProp = component.GetType().GetProperty("enabled", BindingFlags.Public | BindingFlags.Instance);
            if (enabledProp != null && enabledProp.PropertyType == typeof(bool))
                return (bool)enabledProp.GetValue(component, null);
            return null;
        }

        private static string TransformPath(Transform transform)
        {
            if (transform == null)
                return "";
            var names = new List<string>();
            var current = transform;
            while (current != null)
            {
                names.Add(current.name);
                current = current.parent;
            }
            names.Reverse();
            return string.Join("/", names.ToArray());
        }

        private static object ScreenInfo()
        {
            var hwnd = ActiveWindowHandle();
            Native.Rect rect = new Native.Rect();
            var hasWindowRect = hwnd != IntPtr.Zero && Native.GetWindowRect(hwnd, out rect);
            object windowRect = null;
            if (hasWindowRect)
                windowRect = new { left = rect.Left, top = rect.Top, right = rect.Right, bottom = rect.Bottom };
            return new
            {
                width = Screen.width,
                height = Screen.height,
                dpi = Screen.dpi,
                fullScreen = Screen.fullScreen,
                currentResolution = Screen.currentResolution,
                persistentDataPath = Application.persistentDataPath,
                activeWindow = hwnd.ToInt64(),
                windowRect
            };
        }

        private static object FocusWindow()
        {
            var before = Native.GetForegroundWindow();
            var hwnd = GameWindowHandle();
            var restored = false;
            var focused = false;
            if (hwnd != IntPtr.Zero)
            {
                restored = Native.ShowWindow(hwnd, Native.ShowRestore);
                focused = Native.SetForegroundWindow(hwnd);
            }

            Thread.Sleep(50);
            var after = Native.GetForegroundWindow();
            return new
            {
                requestedWindow = hwnd.ToInt64(),
                foregroundBefore = before.ToInt64(),
                foregroundAfter = after.ToInt64(),
                restored,
                focused,
                isForeground = hwnd != IntPtr.Zero && hwnd == after
            };
        }

        private static object CaptureScreen(JObject args)
        {
            var requestedPath = Value<string>(args, "path", null);
            var directory = Value<string>(args, "directory", null);
            if (string.IsNullOrWhiteSpace(directory))
                directory = Path.Combine(Application.persistentDataPath, "CodexMcpBridge", "captures");
            Directory.CreateDirectory(directory);

            var path = requestedPath;
            if (string.IsNullOrWhiteSpace(path))
                path = Path.Combine(directory, "witch_" + DateTime.UtcNow.ToString("yyyyMMdd_HHmmss_fff") + ".png");
            if (!Path.IsPathRooted(path))
                path = Path.Combine(directory, path);

            CaptureScreenshot(path);
            return new
            {
                requestedPath = path,
                fullPath = Path.GetFullPath(path),
                isAsync = true,
                width = Screen.width,
                height = Screen.height,
                capturedAtUtc = DateTime.UtcNow.ToString("o")
            };
        }

        private static void CaptureScreenshot(string path)
        {
            var type = Type.GetType("UnityEngine.ScreenCapture, UnityEngine.CoreModule") ?? Type.GetType("UnityEngine.ScreenCapture, UnityEngine");
            if (type == null)
                throw new InvalidOperationException("UnityEngine.ScreenCapture type was not found.");
            var method = type.GetMethod("CaptureScreenshot", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
            if (method == null)
                throw new MissingMethodException("UnityEngine.ScreenCapture", "CaptureScreenshot(string)");
            method.Invoke(null, new object[] { path });
        }

        private static object SendKeyInput(JObject args)
        {
            if (Value(args, "focus", true))
                FocusWindow();

            var key = Value<string>(args, "key", "");
            var action = Value<string>(args, "action", "press");
            var repeat = Math.Max(1, Value(args, "repeat", 1));
            var modifiers = Values(args["modifiers"] as JArray);
            var vk = VirtualKey(key);
            if (vk == 0)
                throw new InvalidOperationException("Unsupported key: " + key);

            for (var i = 0; i < modifiers.Length; i++)
                KeyDown(VirtualKey(modifiers[i]));

            for (var i = 0; i < repeat; i++)
            {
                if (EqualsIgnoreCase(action, "down"))
                    KeyDown(vk);
                else if (EqualsIgnoreCase(action, "up"))
                    KeyUp(vk);
                else
                    KeyPress(vk);
            }

            for (var i = modifiers.Length - 1; i >= 0; i--)
                KeyUp(VirtualKey(modifiers[i]));

            return new { key, action, repeat, modifiers };
        }

        private static object SendTextInput(JObject args)
        {
            if (Value(args, "focus", true))
                FocusWindow();

            var text = Value<string>(args, "text", "");
            foreach (var ch in text)
            {
                Native.KeyboardInput inputDown = new Native.KeyboardInput();
                inputDown.Type = Native.InputKeyboard;
                inputDown.Data.Keyboard.Scan = ch;
                inputDown.Data.Keyboard.Flags = Native.KeyEventUnicode;

                Native.KeyboardInput inputUp = inputDown;
                inputUp.Data.Keyboard.Flags = Native.KeyEventUnicode | Native.KeyEventKeyUp;

                Native.KeyboardInput[] inputs = { inputDown, inputUp };
                Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.KeyboardInput)));
            }
            return new { length = text.Length };
        }

        private static object SendMouseInput(JObject args)
        {
            if (Value(args, "focus", true))
                FocusWindow();

            var action = Value<string>(args, "action", "click");
            var button = Value<string>(args, "button", "left");
            var origin = Value<string>(args, "origin", "unity");
            var steps = Math.Max(1, Value(args, "steps", 12));
            var x = Value(args, "x", double.NaN);
            var y = Value(args, "y", double.NaN);
            var targetX = Value(args, "targetX", double.NaN);
            var targetY = Value(args, "targetY", double.NaN);

            Native.Point start = CurrentCursor();
            if (!double.IsNaN(x) && !double.IsNaN(y))
            {
                start = ClientPoint(x, y, origin);
                Native.SetCursorPos(start.X, start.Y);
            }

            if (EqualsIgnoreCase(action, "move"))
                return new { action, button, position = start };

            if (EqualsIgnoreCase(action, "down"))
            {
                MouseButton(button, true);
                return new { action, button, position = start };
            }
            if (EqualsIgnoreCase(action, "up"))
            {
                MouseButton(button, false);
                return new { action, button, position = start };
            }
            if (EqualsIgnoreCase(action, "scroll"))
            {
                var delta = Value(args, "delta", Value(args, "scrollY", 0));
                Native.mouse_event(Native.MouseWheel, 0, 0, delta, UIntPtr.Zero);
                return new { action, button, position = start, delta };
            }
            if (EqualsIgnoreCase(action, "drag"))
            {
                if (double.IsNaN(targetX) || double.IsNaN(targetY))
                    throw new InvalidOperationException("input.mouse drag requires targetX and targetY.");
                var end = ClientPoint(targetX, targetY, origin);
                MouseButton(button, true);
                for (var i = 1; i <= steps; i++)
                {
                    var px = start.X + (end.X - start.X) * i / steps;
                    var py = start.Y + (end.Y - start.Y) * i / steps;
                    Native.SetCursorPos(px, py);
                    Thread.Sleep(8);
                }
                MouseButton(button, false);
                return new { action, button, from = start, to = end, steps };
            }

            MouseButton(button, true);
            MouseButton(button, false);
            if (EqualsIgnoreCase(action, "double_click"))
            {
                MouseButton(button, true);
                MouseButton(button, false);
            }
            return new { action, button, position = start };
        }

        private static Native.Point CurrentCursor()
        {
            Native.Point point;
            if (!Native.GetCursorPos(out point))
            {
                point = new Native.Point();
            }
            return point;
        }

        private static Native.Point ClientPoint(double x, double y, string origin)
        {
            var point = new Native.Point { X = (int)Math.Round(x), Y = (int)Math.Round(y) };
            if (!EqualsIgnoreCase(origin, "topLeft") && !EqualsIgnoreCase(origin, "desktop"))
                point.Y = Screen.height - point.Y;
            if (!EqualsIgnoreCase(origin, "desktop"))
            {
                var hwnd = ActiveWindowHandle();
                if (hwnd != IntPtr.Zero)
                    Native.ClientToScreen(hwnd, ref point);
            }
            return point;
        }

        private static IntPtr ActiveWindowHandle()
        {
            var hwnd = Native.GetActiveWindow();
            if (hwnd == IntPtr.Zero)
                hwnd = GameWindowHandle();
            return hwnd;
        }

        private static IntPtr GameWindowHandle()
        {
            var hwnd = Native.GetActiveWindow();
            if (hwnd != IntPtr.Zero)
                return hwnd;

            var process = System.Diagnostics.Process.GetCurrentProcess();
            hwnd = process.MainWindowHandle;
            if (hwnd != IntPtr.Zero)
                return hwnd;

            return Native.GetForegroundWindow();
        }

        private static void MouseButton(string button, bool down)
        {
            uint flag;
            if (EqualsIgnoreCase(button, "right"))
                flag = down ? Native.MouseRightDown : Native.MouseRightUp;
            else if (EqualsIgnoreCase(button, "middle"))
                flag = down ? Native.MouseMiddleDown : Native.MouseMiddleUp;
            else
                flag = down ? Native.MouseLeftDown : Native.MouseLeftUp;
            Native.mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
        }

        private static void KeyPress(ushort vk)
        {
            KeyDown(vk);
            KeyUp(vk);
        }

        private static void KeyDown(ushort vk)
        {
            if (vk != 0)
                Native.keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
        }

        private static void KeyUp(ushort vk)
        {
            if (vk != 0)
                Native.keybd_event((byte)vk, 0, Native.KeyEventKeyUp, UIntPtr.Zero);
        }

        private static ushort VirtualKey(string key)
        {
            if (string.IsNullOrWhiteSpace(key))
                return 0;
            key = key.Trim();
            if (key.Length == 1)
            {
                var ch = char.ToUpperInvariant(key[0]);
                if (ch >= 'A' && ch <= 'Z')
                    return (ushort)ch;
                if (ch >= '0' && ch <= '9')
                    return (ushort)ch;
            }

            var normalized = key.Replace("_", "").Replace("-", "").Replace(" ", "").ToLowerInvariant();
            if (normalized.StartsWith("f"))
            {
                int fNumber;
                if (int.TryParse(normalized.Substring(1), out fNumber) && fNumber >= 1 && fNumber <= 24)
                    return (ushort)(0x70 + fNumber - 1);
            }

            switch (normalized)
            {
                case "backspace": return 0x08;
                case "tab": return 0x09;
                case "enter":
                case "return": return 0x0D;
                case "shift": return 0x10;
                case "ctrl":
                case "control": return 0x11;
                case "alt": return 0x12;
                case "pause": return 0x13;
                case "capslock": return 0x14;
                case "escape":
                case "esc": return 0x1B;
                case "space": return 0x20;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "end": return 0x23;
                case "home": return 0x24;
                case "left": return 0x25;
                case "up": return 0x26;
                case "right": return 0x27;
                case "down": return 0x28;
                case "insert": return 0x2D;
                case "delete":
                case "del": return 0x2E;
                case "leftwin":
                case "win": return 0x5B;
                case "rightwin": return 0x5C;
                case "num0": return 0x60;
                case "num1": return 0x61;
                case "num2": return 0x62;
                case "num3": return 0x63;
                case "num4": return 0x64;
                case "num5": return 0x65;
                case "num6": return 0x66;
                case "num7": return 0x67;
                case "num8": return 0x68;
                case "num9": return 0x69;
                case "multiply": return 0x6A;
                case "add":
                case "plus": return 0x6B;
                case "subtract":
                case "minus": return 0x6D;
                case "decimal": return 0x6E;
                case "divide": return 0x6F;
                default: return 0;
            }
        }

        private static string[] Values(JArray array)
        {
            if (array == null)
                return new string[0];
            var values = new string[array.Count];
            for (var i = 0; i < array.Count; i++)
                values[i] = array[i] == null ? "" : array[i].Value<string>();
            return values;
        }

        private static bool EqualsIgnoreCase(string left, string right)
        {
            return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }

        private static object BuildUiSnapshotRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimeUiSnapshotRequest");
            Set(obj, "IncludeHidden", Value(args, "includeHidden", false));
            Set(obj, "Scope", Value<string>(args, "scope", ""));
            return obj;
        }

        private static object BuildUiInteractionRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimeUiInteractionRequest");
            Set(obj, "Action", Value<string>(args, "action", "click"));
            Set(obj, "Selector", BuildUiSelector(args["selector"] as JObject));
            Set(obj, "TargetSelector", BuildUiSelector(args["targetSelector"] as JObject));
            Set(obj, "TargetPoint", BuildPoint(args["targetPoint"] as JObject));
            Set(obj, "Text", Value<string>(args, "text", null));
            Set(obj, "Submit", Value(args, "submit", false));
            Set(obj, "RequireClickable", Value(args, "requireClickable", true));
            Set(obj, "Button", Value<string>(args, "button", "left"));
            Set(obj, "DeltaX", Value(args, "deltaX", 0.0));
            Set(obj, "DeltaY", Value(args, "deltaY", 0.0));
            Set(obj, "Steps", Value(args, "steps", 12));
            Set(obj, "FramesPerStep", Value(args, "framesPerStep", 1));
            Set(obj, "IncludePostSnapshot", Value(args, "includePostSnapshot", true));
            return obj;
        }

        private static object BuildUiWaitRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimeUiWaitRequest");
            Set(obj, "Condition", Value<string>(args, "condition", ""));
            Set(obj, "Selector", BuildUiSelector(args["selector"] as JObject));
            Set(obj, "WindowName", Value<string>(args, "windowName", null));
            Set(obj, "ExpectedText", Value<string>(args, "expectedText", null));
            return obj;
        }

        private static object BuildUiSelector(JObject args)
        {
            if (args == null)
                return null;

            var obj = New("Witch.UI.Automation.RuntimeUiNodeSelector");
            Set(obj, "NodeId", Value<string>(args, "nodeId", null));
            Set(obj, "InstanceId", NullableInt(args, "instanceId"));
            Set(obj, "WindowName", Value<string>(args, "windowName", null));
            Set(obj, "TransformPath", Value<string>(args, "transformPath", null));
            Set(obj, "Label", Value<string>(args, "label", null));
            return obj;
        }

        private static object BuildSceneSnapshotRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimeSceneSnapshotRequest");
            Set(obj, "IncludeInactive", Value(args, "includeInactive", false));
            Set(obj, "OnlyInteractive", Value(args, "onlyInteractive", true));
            return obj;
        }

        private static object BuildSceneRaycastRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimeSceneRaycastRequest");
            Set(obj, "X", Value(args, "x", 0.0));
            Set(obj, "Y", Value(args, "y", 0.0));
            Set(obj, "Distance", Value(args, "distance", 1000.0));
            return obj;
        }

        private static object BuildSceneInteractionRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimeSceneInteractionRequest");
            Set(obj, "Action", Value<string>(args, "action", "click"));
            Set(obj, "Selector", BuildSceneSelector(args["selector"] as JObject));
            Set(obj, "TargetSelector", BuildSceneSelector(args["targetSelector"] as JObject));
            Set(obj, "ScreenPoint", BuildPoint(args["screenPoint"] as JObject));
            Set(obj, "TargetPoint", BuildPoint(args["targetPoint"] as JObject));
            Set(obj, "Button", Value<string>(args, "button", "left"));
            Set(obj, "ScrollX", Value(args, "scrollX", 0.0));
            Set(obj, "ScrollY", Value(args, "scrollY", 0.0));
            Set(obj, "Steps", Value(args, "steps", 12));
            Set(obj, "FramesPerStep", Value(args, "framesPerStep", 1));
            return obj;
        }

        private static object BuildSceneSelector(JObject args)
        {
            if (args == null)
                return null;

            var obj = New("Witch.UI.Automation.RuntimeSceneObjectSelector");
            Set(obj, "ObjectId", Value<string>(args, "objectId", null));
            Set(obj, "InstanceId", NullableInt(args, "instanceId"));
            Set(obj, "TransformPath", Value<string>(args, "transformPath", null));
            Set(obj, "Name", Value<string>(args, "name", null));
            return obj;
        }

        private static object BuildPerformActionRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimePerformActionRequest");
            Set(obj, "ActionId", Value<string>(args, "actionId", ""));
            return obj;
        }

        private static object BuildPlayCardRequest(JObject args)
        {
            var obj = New("Witch.UI.Automation.RuntimePlayCardRequest");
            Set(obj, "CardInstanceId", NullableInt(args, "cardInstanceId"));
            Set(obj, "CardId", Value<string>(args, "cardId", null));
            Set(obj, "CardIndex", NullableInt(args, "cardIndex"));
            Set(obj, "TargetInstanceId", NullableInt(args, "targetInstanceId"));
            Set(obj, "TargetName", Value<string>(args, "targetName", null));
            Set(obj, "TargetIndex", NullableInt(args, "targetIndex"));
            return obj;
        }

        private static object CaptureBattleSnapshot(JObject args)
        {
            var includeInactive = Value(args, "includeInactive", false);
            var maxCards = Math.Max(0, Math.Min(100, Value(args, "maxCards", 40)));
            var maxTargets = Math.Max(0, Math.Min(100, Value(args, "maxTargets", 40)));
            var cards = new List<object>();
            var targets = new List<object>();
            var cardIndex = 0;
            var targetIndex = 0;

            foreach (var component in FindComponents(includeInactive))
            {
                if (component == null)
                    continue;
                var go = component.gameObject;
                if (go == null || (!includeInactive && !go.activeInHierarchy))
                    continue;
                var type = component.GetType();
                if (IsBattleCardComponent(type) && cards.Count < maxCards)
                {
                    cards.Add(DescribeBattleCard(component, cardIndex));
                    cardIndex++;
                }
                else if (IsBattleTargetComponent(type) && targets.Count < maxTargets)
                {
                    targets.Add(DescribeBattleTarget(component, targetIndex));
                    targetIndex++;
                }
            }

            return new
            {
                capturedAtUtc = DateTime.UtcNow.ToString("o"),
                inBattle = cards.Count > 0 || targets.Count > 0,
                cardCount = cards.Count,
                targetCount = targets.Count,
                cards,
                targets,
                supportedActions = targets.Count > 0 ? new[] { "play_card", "play_card_target" } : new[] { "play_card" }
            };
        }

        private static object DescribeBattleCard(UnityEngine.Component component, int index)
        {
            var go = component.gameObject;
            var values = ReadNamedValues(component, new[]
            {
                "Id", "id", "CardId", "cardId", "Type", "type", "CardType", "cardType", "Name", "name",
                "Index", "index", "Cost", "cost", "CanUse", "canUse", "isLine", "isReverse", "ignore", "draging"
            }, 300);
            var data = ReadNestedNamedValues(component, new[] { "DataConfig", "dataConfig", "data", "Data" }, new[]
            {
                "Id", "id", "Name", "name", "Title", "title", "Type", "type", "Cost", "cost", "Description", "description", "Note", "note"
            }, 300);
            var cardId = FirstStringValue(values, data, new[] { "CardId", "cardId", "Id", "id" });
            return new
            {
                index,
                cardIndex = index,
                cardId,
                instanceId = component.GetInstanceID(),
                objectInstanceId = go.GetInstanceID(),
                objectName = go.name,
                componentType = component.GetType().FullName,
                path = TransformPath(go.transform),
                activeInHierarchy = go.activeInHierarchy,
                values,
                data,
                playCardCall = new
                {
                    tool = "witch_play_card",
                    arguments = string.IsNullOrWhiteSpace(cardId)
                        ? new { cardIndex = (int?)index, cardInstanceId = (int?)null, cardId = (string)null }
                        : new { cardIndex = (int?)index, cardInstanceId = (int?)component.GetInstanceID(), cardId }
                }
            };
        }

        private static object DescribeBattleTarget(UnityEngine.Component component, int index)
        {
            var go = component.gameObject;
            var values = ReadNamedValues(component, new[]
            {
                "Id", "id", "InstanceId", "instanceId", "Name", "name", "Hp", "hp", "HP", "MaxHp", "maxHp",
                "Health", "health", "Shield", "shield", "State", "state", "isDead", "dead"
            }, 300);
            var data = ReadNestedNamedValues(component, new[] { "fatherObject", "FatherObject", "data", "Data", "DataConfig", "dataConfig" }, new[]
            {
                "Id", "id", "Name", "name", "Type", "type", "Hp", "hp", "MaxHp", "maxHp", "Description", "description"
            }, 300);
            var targetName = FirstStringValue(values, data, new[] { "Name", "name", "Id", "id" });
            return new
            {
                index,
                targetIndex = index,
                targetName,
                instanceId = component.GetInstanceID(),
                objectInstanceId = go.GetInstanceID(),
                objectName = go.name,
                componentType = component.GetType().FullName,
                path = TransformPath(go.transform),
                activeInHierarchy = go.activeInHierarchy,
                values,
                data
            };
        }

        private static UnityEngine.Component[] FindComponents(bool includeInactive)
        {
            var components = new List<UnityEngine.Component>();
            foreach (var go in FindGameObjects(includeInactive))
            {
                if (go == null || (!includeInactive && !go.activeInHierarchy))
                    continue;
                components.AddRange(go.GetComponents<UnityEngine.Component>());
            }
            return components.ToArray();
        }

        private static bool IsBattleCardComponent(Type type)
        {
            if (type == null)
                return false;
            return ContainsIgnoreCase(type.Name, "CardItem") || ContainsIgnoreCase(type.FullName, ".CardItem");
        }

        private static bool IsBattleTargetComponent(Type type)
        {
            if (type == null)
                return false;
            return EqualsIgnoreCase(type.Name, "StatusManager")
                || ContainsIgnoreCase(type.FullName, ".StatusManager")
                || ContainsIgnoreCase(type.Name, "EnemyItem")
                || ContainsIgnoreCase(type.FullName, ".EnemyItem");
        }

        private static Dictionary<string, object> ReadNamedValues(object obj, string[] names, int maxStringLength)
        {
            var values = new Dictionary<string, object>();
            if (obj == null)
                return values;
            var type = obj.GetType();
            for (var i = 0; i < names.Length; i++)
            {
                var name = names[i];
                if (values.ContainsKey(name))
                    continue;
                var prop = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (prop != null && prop.CanRead && prop.GetIndexParameters().Length == 0)
                {
                    values[name] = ReadMemberValue(() => prop.GetValue(obj, null), prop.PropertyType, maxStringLength);
                    continue;
                }
                var field = type.GetField(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (field != null)
                    values[name] = ReadMemberValue(() => field.GetValue(obj), field.FieldType, maxStringLength);
            }
            return values;
        }

        private static Dictionary<string, object> ReadNestedNamedValues(object obj, string[] containerNames, string[] names, int maxStringLength)
        {
            var result = new Dictionary<string, object>();
            if (obj == null)
                return result;
            var type = obj.GetType();
            for (var i = 0; i < containerNames.Length; i++)
            {
                object nested = null;
                var containerName = containerNames[i];
                var prop = type.GetProperty(containerName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (prop != null && prop.CanRead && prop.GetIndexParameters().Length == 0)
                    nested = SafeGet(() => prop.GetValue(obj, null));
                if (nested == null)
                {
                    var field = type.GetField(containerName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                    if (field != null)
                        nested = SafeGet(() => field.GetValue(obj));
                }
                if (nested == null)
                    continue;
                var values = ReadNamedValues(nested, names, maxStringLength);
                foreach (var item in values)
                    result[containerName + "." + item.Key] = item.Value;
            }
            return result;
        }

        private delegate object ObjectReader();

        private static object SafeGet(ObjectReader reader)
        {
            try
            {
                return reader();
            }
            catch
            {
                return null;
            }
        }

        private static string FirstStringValue(Dictionary<string, object> primary, Dictionary<string, object> secondary, string[] names)
        {
            for (var i = 0; i < names.Length; i++)
            {
                var value = ExtractStringValue(primary, names[i]);
                if (!string.IsNullOrWhiteSpace(value))
                    return value;
                value = ExtractStringValue(secondary, names[i]);
                if (!string.IsNullOrWhiteSpace(value))
                    return value;
            }
            foreach (var item in secondary)
            {
                for (var i = 0; i < names.Length; i++)
                {
                    if (!item.Key.EndsWith("." + names[i], StringComparison.OrdinalIgnoreCase))
                        continue;
                    var value = ExtractStringValue(secondary, item.Key);
                    if (!string.IsNullOrWhiteSpace(value))
                        return value;
                }
            }
            return null;
        }

        private static string ExtractStringValue(Dictionary<string, object> values, string key)
        {
            if (values == null || !values.ContainsKey(key) || values[key] == null)
                return null;
            var str = values[key] as string;
            if (str != null)
                return str;
            var dict = values[key] as IDictionary<string, object>;
            if (dict != null)
            {
                if (dict.ContainsKey("text") && dict["text"] != null)
                    return Convert.ToString(dict["text"]);
                if (dict.ContainsKey("name") && dict["name"] != null)
                    return Convert.ToString(dict["name"]);
            }
            return Convert.ToString(values[key]);
        }

        private static object BuildPoint(JObject args)
        {
            if (args == null)
                return null;

            var obj = New("Witch.UI.Automation.RuntimeUiPoint");
            Set(obj, "X", Value(args, "x", 0.0));
            Set(obj, "Y", Value(args, "y", 0.0));
            return obj;
        }

        private static object InvokeStatic(string typeName, string methodName, params object[] args)
        {
            var type = FindType(typeName);
            if (type == null)
                throw new InvalidOperationException("Type not found: " + typeName);

            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (method.Name != methodName)
                    continue;
                var parameters = method.GetParameters();
                if (parameters.Length == args.Length)
                    return method.Invoke(null, args);
            }

            throw new MissingMethodException(typeName, methodName);
        }

        private static object New(string typeName)
        {
            var type = FindType(typeName);
            if (type == null)
                throw new InvalidOperationException("Type not found: " + typeName);
            return Activator.CreateInstance(type);
        }

        private static Type FindType(string typeName)
        {
            if (string.IsNullOrWhiteSpace(typeName))
                return null;

            var type = Type.GetType(typeName + ", Witch") ?? Type.GetType(typeName);
            if (type != null)
                return type;

            var assemblies = AppDomain.CurrentDomain.GetAssemblies();
            foreach (var assembly in assemblies)
            {
                type = assembly.GetType(typeName, false);
                if (type != null)
                    return type;
            }

            foreach (var assembly in assemblies)
            {
                Type[] types;
                try
                {
                    types = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    types = ex.Types;
                }
                catch
                {
                    continue;
                }

                foreach (var candidate in types)
                {
                    if (candidate == null)
                        continue;
                    if (candidate.FullName == typeName || candidate.Name == typeName)
                        return candidate;
                }
            }

            return null;
        }

        private static void Set(object obj, string name, object value)
        {
            if (obj == null || value == null)
                return;

            var prop = obj.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (prop != null && prop.CanWrite)
            {
                var converted = ConvertValue(value, prop.PropertyType);
                prop.SetValue(obj, converted, null);
                return;
            }

            var field = obj.GetType().GetField(name, BindingFlags.Public | BindingFlags.Instance);
            if (field != null)
            {
                var converted = ConvertValue(value, field.FieldType);
                field.SetValue(obj, converted);
            }
        }

        private static object ConvertValue(object value, Type targetType)
        {
            if (value == null)
                return null;

            var nullable = Nullable.GetUnderlyingType(targetType);
            if (nullable != null)
                targetType = nullable;

            if (targetType.IsInstanceOfType(value))
                return value;

            if (targetType.IsEnum)
                return Enum.Parse(targetType, value.ToString(), true);

            return Convert.ChangeType(value, targetType);
        }

        private static int? NullableInt(JObject args, string name)
        {
            var token = args == null ? null : args[name];
            if (token == null || token.Type == JTokenType.Null)
                return null;
            return token.Value<int>();
        }

        private static T Value<T>(JObject args, string name, T defaultValue)
        {
            var token = args == null ? null : args[name];
            if (token == null || token.Type == JTokenType.Null)
                return defaultValue;
            return token.Value<T>();
        }

        private static object Ok(object data)
        {
            return new { ok = true, data };
        }

        private static object Fail(string error)
        {
            return new { ok = false, error };
        }

        private static class Native
        {
            public const uint InputKeyboard = 1;
            public const uint KeyEventKeyUp = 0x0002;
            public const uint KeyEventUnicode = 0x0004;
            public const uint MouseLeftDown = 0x0002;
            public const uint MouseLeftUp = 0x0004;
            public const uint MouseRightDown = 0x0008;
            public const uint MouseRightUp = 0x0010;
            public const uint MouseMiddleDown = 0x0020;
            public const uint MouseMiddleUp = 0x0040;
            public const uint MouseWheel = 0x0800;
            public const int ShowRestore = 9;

            [StructLayout(LayoutKind.Sequential)]
            public struct Point
            {
                public int X;
                public int Y;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct Rect
            {
                public int Left;
                public int Top;
                public int Right;
                public int Bottom;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct KeyboardInputData
            {
                public ushort Vk;
                public ushort Scan;
                public uint Flags;
                public uint Time;
                public IntPtr ExtraInfo;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct MouseInputData
            {
                public int Dx;
                public int Dy;
                public uint MouseData;
                public uint Flags;
                public uint Time;
                public IntPtr ExtraInfo;
            }

            [StructLayout(LayoutKind.Explicit)]
            public struct InputData
            {
                [FieldOffset(0)]
                public KeyboardInputData Keyboard;

                [FieldOffset(0)]
                public MouseInputData Mouse;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct KeyboardInput
            {
                public uint Type;
                public InputData Data;
            }

            [DllImport("user32.dll")]
            public static extern bool SetCursorPos(int x, int y);

            [DllImport("user32.dll")]
            public static extern bool GetCursorPos(out Point point);

            [DllImport("user32.dll")]
            public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);

            [DllImport("user32.dll")]
            public static extern IntPtr GetActiveWindow();

            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();

            [DllImport("user32.dll")]
            public static extern bool SetForegroundWindow(IntPtr hwnd);

            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hwnd, int command);

            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

            [DllImport("user32.dll")]
            public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extraInfo);

            [DllImport("user32.dll")]
            public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);

            [DllImport("user32.dll", SetLastError = true)]
            public static extern uint SendInput(uint inputCount, KeyboardInput[] inputs, int size);
        }

        private static void Write(HttpListenerContext context, int statusCode, object payload)
        {
            var json = JsonConvert.SerializeObject(payload, new JsonSerializerSettings
            {
                ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
                NullValueHandling = NullValueHandling.Ignore
            });
            var bytes = Encoding.UTF8.GetBytes(json);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.ContentLength64 = bytes.Length;
            context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.OutputStream.Close();
        }
    }

    public sealed class BridgeRunner : MonoBehaviour
    {
        private void Update()
        {
            BridgeServer.Pump();
            BridgeServer.PumpPending();
        }
    }
}
