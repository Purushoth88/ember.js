import {
  StatementSyntax,
  ValueReference,
  EvaluatedArgs,
  EvaluatedNamedArgs,
  EvaluatedPositionalArgs,
  ComponentDefinition
} from 'glimmer-runtime';
import { AttributeBinding, ClassNameBinding, IsVisibleBinding } from '../utils/bindings';
import { ROOT_REF, DIRTY_TAG, IS_DISPATCHING_ATTRS, HAS_BLOCK, BOUNDS } from '../component';
import {
  assert,
  runInDebug,
  assign,
  get,
  _instrumentStart
} from 'ember-metal';
import processArgs from '../utils/process-args';
import {
  privatize as P,
  OWNER
} from 'container';
import { environment } from 'ember-environment';

const DEFAULT_LAYOUT = P`template:components/-default`;

function processComponentInitializationAssertions(component, props) {
  assert(`classNameBindings must not have spaces in them: ${component.toString()}`, (() => {
    let { classNameBindings } = component;
    for (let i = 0; i < classNameBindings.length; i++) {
      let binding = classNameBindings[i];
      if (binding.split(' ').length > 1) {
        return false;
      }
    }
    return true;
  })());

  assert('You cannot use `classNameBindings` on a tag-less component: ' + component.toString(), (() => {
    let { classNameBindings, tagName } = component;
    return tagName !== '' || !classNameBindings || classNameBindings.length === 0;
  })());

  assert('You cannot use `elementId` on a tag-less component: ' + component.toString(), (() => {
    let { elementId, tagName } = component;
    return tagName !== '' || props.id === elementId || (!elementId && elementId !== '');
  })());

  assert('You cannot use `attributeBindings` on a tag-less component: ' + component.toString(), (() => {
    let { attributeBindings, tagName } = component;
    return tagName !== '' || !attributeBindings || attributeBindings.length === 0;
  })());
}

export function validatePositionalParameters(named, positional, positionalParamsDefinition) {
  runInDebug(() => {
    if (!named || !positional || !positional.length) {
      return;
    }

    let paramType = typeof positionalParamsDefinition;

    if (paramType === 'string') {
      assert(`You cannot specify positional parameters and the hash argument \`${positionalParamsDefinition}\`.`, !named.has(positionalParamsDefinition));
    } else {
      if (positional.length < positionalParamsDefinition.length) {
        positionalParamsDefinition = positionalParamsDefinition.slice(0, positional.length);
      }

      for (let i = 0; i < positionalParamsDefinition.length; i++) {
        let name = positionalParamsDefinition[i];

        assert(
          `You cannot specify both a positional param (at position ${i}) and the hash argument \`${name}\`.`,
          !named.has(name)
        );
      }
    }
  });
}

function aliasIdToElementId(args, props) {
  if (args.named.has('id')) {
    assert(`You cannot invoke a component with both 'id' and 'elementId' at the same time.`, !args.named.has('elementId'));
    props.elementId = props.id;
  }
}

// We must traverse the attributeBindings in reverse keeping track of
// what has already been applied. This is essentially refining the concated
// properties applying right to left.
function applyAttributeBindings(element, attributeBindings, component, operations) {
  let seen = [];
  let i = attributeBindings.length - 1;

  while (i !== -1) {
    let binding = attributeBindings[i];
    let parsed = AttributeBinding.parse(binding);
    let attribute = parsed[1];

    if (seen.indexOf(attribute) === -1) {
      seen.push(attribute);
      AttributeBinding.install(element, component, parsed, operations);
    }

    i--;
  }

  if (seen.indexOf('id') === -1) {
    operations.addStaticAttribute(element, 'id', component.elementId);
  }

  if (seen.indexOf('style') === -1) {
    IsVisibleBinding.install(element, component, operations);
  }
}

export class CurlyComponentSyntax extends StatementSyntax {
  constructor(args, definition, templates, symbolTable) {
    super();
    this.args = args;
    this.definition = definition;
    this.templates = templates;
    this.symbolTable = symbolTable;
    this.shadow = null;
  }

  compile(builder) {
    builder.component.static(this.definition, this.args, this.templates, this.symbolTable, this.shadow);
  }
}

function NOOP() {}

class ComponentStateBucket {
  constructor(environment, component, args, finalizer) {
    this.environment = environment;
    this.component = component;
    this.classRef = null;
    this.args = args;
    this.argsRevision = args.tag.value();
    this.finalizer = finalizer;
  }

  finalize() {
    let { finalizer } = this;
    finalizer();
    this.finalizer = NOOP;
  }
}

function initialRenderInstrumentDetails(component) {
  return component.instrumentDetails({ initialRender: true });
}

function rerenderInstrumentDetails(component) {
  return component.instrumentDetails({ initialRender: false });
}

class CurlyComponentManager {
  prepareArgs(definition, args) {
    validatePositionalParameters(args.named, args.positional.values, definition.ComponentClass.positionalParams);

    if (definition.args) {
      let newNamed = args.named.map;
      let newPositional = args.positional.values;

      let oldNamed = definition.args.named.map;
      let oldPositional = definition.args.positional.values;

      // Merge positional arrays
      let mergedPositional = [];

      mergedPositional.push(...oldPositional);
      mergedPositional.splice(0, newPositional.length, ...newPositional);

      // Merge named maps
      let mergedNamed = assign({}, oldNamed, newNamed);

      // THOUGHT: It might be nice to have a static method on EvaluatedArgs that
      // can merge two sets of args for us.
      let mergedArgs = EvaluatedArgs.create(
        EvaluatedPositionalArgs.create(mergedPositional),
        EvaluatedNamedArgs.create(mergedNamed)
      );

      return mergedArgs;
    }

    return args;
  }

  create(environment, definition, args, dynamicScope, callerSelfRef, hasBlock) {
    let parentView = dynamicScope.view;

    let klass = definition.ComponentClass;
    let processedArgs = processArgs(args, klass.positionalParams);
    let { attrs, props } = processedArgs.value();

    aliasIdToElementId(args, props);

    props.parentView = parentView;
    props[HAS_BLOCK] = hasBlock;

    props._targetObject = callerSelfRef.value();

    let component = klass.create(props);

    let finalizer = _instrumentStart('render.component', initialRenderInstrumentDetails, component);

    dynamicScope.view = component;

    if (parentView !== null) {
      parentView.appendChild(component);
    }

    component.trigger('didInitAttrs', { attrs });
    component.trigger('didReceiveAttrs', { newAttrs: attrs });

    if (environment.hasDOM) {
      component.trigger('willInsertElement');
    }

    component.trigger('willRender');

    let bucket = new ComponentStateBucket(environment, component, processedArgs, finalizer);

    if (args.named.has('class')) {
      bucket.classRef = args.named.get('class');
    }

    processComponentInitializationAssertions(component, props);

    return bucket;
  }

  layoutFor(definition, bucket, env) {
    let template = definition.template;
    if (!template) {
      let { component } = bucket;
      template = this.templateFor(component, env);
    }
    return env.getCompiledBlock(CurlyComponentLayoutCompiler, template);
  }

  templateFor(component, env) {
    let Template = component.layout;
    let owner = component[OWNER];
    if (Template) {
      return env.getTemplate(Template, owner);
    }
    let layoutName = get(component, 'layoutName');
    if (layoutName) {
      let template = owner.lookup('template:' + layoutName);
      if (template) {
        return template;
      }
    }
    return owner.lookup(DEFAULT_LAYOUT);
  }

  getSelf({ component }) {
    return component[ROOT_REF];
  }

  didCreateElement({ component, classRef }, element, operations) {
    component.element = element;

    let { attributeBindings, classNames, classNameBindings } = component;

    if (attributeBindings && attributeBindings.length) {
      applyAttributeBindings(element, attributeBindings, component, operations);
    } else {
      operations.addStaticAttribute(element, 'id', component.elementId);
      IsVisibleBinding.install(element, component, operations);
    }

    if (classRef) {
      operations.addDynamicAttribute(element, 'class', classRef);
    }

    if (classNames && classNames.length) {
      classNames.forEach(name => {
        operations.addStaticAttribute(element, 'class', name);
      });
    }

    if (classNameBindings && classNameBindings.length) {
      classNameBindings.forEach(binding => {
        ClassNameBinding.install(element, component, binding, operations);
      });
    }

    component._transitionTo('hasElement');
  }

  didRenderLayout(bucket, bounds) {
    bucket.component[BOUNDS] = bounds;
    bucket.finalize();
  }

  getTag({ component }) {
    return component[DIRTY_TAG];
  }

  didCreate({ component }) {
    if (environment.hasDOM) {
      component.trigger('didInsertElement');
      component.trigger('didRender');
      component._transitionTo('inDOM');
    }
  }

  update(bucket, _, dynamicScope) {
    let { component, args, argsRevision } = bucket;

    bucket.finalizer = _instrumentStart('render.component', rerenderInstrumentDetails, component);

    if (!args.tag.validate(argsRevision)) {
      let { attrs, props } = args.value();

      bucket.argsRevision = args.tag.value();

      let oldAttrs = component.attrs;
      let newAttrs = attrs;

      component[IS_DISPATCHING_ATTRS] = true;
      component.setProperties(props);
      component[IS_DISPATCHING_ATTRS] = false;

      component.trigger('didUpdateAttrs', { oldAttrs, newAttrs });
      component.trigger('didReceiveAttrs', { oldAttrs, newAttrs });
    }

    component.trigger('willUpdate');
    component.trigger('willRender');
  }

  didUpdateLayout(bucket) {
    bucket.finalize();
  }

  didUpdate({ component }) {
    component.trigger('didUpdate');
    component.trigger('didRender');
  }

  getDestructor({ component }) {
    return component;
  }
}

const MANAGER = new CurlyComponentManager();

class TopComponentManager extends CurlyComponentManager {
  create(environment, definition, args, dynamicScope, currentScope, hasBlock) {
    let component = definition.ComponentClass;

    let finalizer = _instrumentStart('render.component', initialRenderInstrumentDetails, component);

    dynamicScope.view = component;

    component.trigger('didInitAttrs');
    component.trigger('didReceiveAttrs');
    component.trigger('willInsertElement');
    component.trigger('willRender');

    processComponentInitializationAssertions(component, {});

    return new ComponentStateBucket(environment, component, args, finalizer);
  }
}

const ROOT_MANAGER = new TopComponentManager();

function tagName(vm) {
  let { tagName } = vm.dynamicScope().view;

  return new ValueReference(tagName === '' ? null : tagName || 'div');
}

function ariaRole(vm) {
  return vm.getSelf().get('ariaRole');
}

export class CurlyComponentDefinition extends ComponentDefinition {
  constructor(name, ComponentClass, template, args) {
    super(name, MANAGER, ComponentClass);
    this.template = template;
    this.args = args;
  }
}

export class RootComponentDefinition extends ComponentDefinition {
  constructor(instance) {
    super('-root', ROOT_MANAGER, instance);
    this.template = undefined;
    this.args = undefined;
  }
}

class CurlyComponentLayoutCompiler {
  constructor(template) {
    this.template = template;
  }

  compile(builder) {
    builder.wrapLayout(this.template.asLayout());
    builder.tag.dynamic(tagName);
    builder.attrs.dynamic('role', ariaRole);
    builder.attrs.static('class', 'ember-view');
  }
}

CurlyComponentLayoutCompiler.id = 'curly';
