import {
  reaction,
  decorate,
  action,
  computed,
  observable,
  isObservableArray,
  toJS,
} from 'mobx';

export const map = (arr, mapFn) => {
  if (isObservableArray(arr)) {
    const result = observable.array();
    arr.observe(
      action(changeData => {
        switch (changeData.type) {
          case 'splice':
            result.splice(
              changeData.index,
              changeData.removedCount,
              ...changeData.added.map((value, index) =>
                mapFn(value, index + changeData.index),
              ),
            );
            break;
          case 'update':
            result.splice(
              changeData.index,
              1,
              mapFn(changeData.newValue, changeData.index),
            );
            break;
        }
      }),
      true,
    );
    return result;
  }
  return arr.map(mapFn);
};

const PROPS = Symbol('props');
const assignAttribute = action((element, key, value) => {
  if(key === 'style') {
    Object.keys(value).forEach(key => {
      element.style[key] = value[key];
    })
  } else {
    element[key] = value;
    if (element[PROPS]) {
      element[PROPS][key] = value;
    }  
  }
});

function applyAttribute(element, attributes, key) {
  const attributeValue = attributes[key];
  if (typeof attributeValue === 'function') {
    reaction(
      attributeValue,
      action(value => {
        assignAttribute(element, key, value);
      }),
      { fireImmediately: true },
    );
  } else {
    assignAttribute(element, key, attributeValue);
  }  
}

function assignAttributes(element, attributes) {
  if (!attributes) {
    return;
  }
  Object.keys(attributes).forEach(key => {
    applyAttribute(element, attributes, key);
  });
}

function removeChildren(element, childOrChildren) {
  if (childOrChildren === undefined) {
    return;
  }
  if (childOrChildren === null) {
    return;
  }
  if (Array.isArray(childOrChildren)) {
    childOrChildren.map(child => removeChildren(element, child));
    return;
  }
  if (childOrChildren instanceof Node) {
    element.removeChild(childOrChildren);
    return;
  }
  if (childOrChildren.array) {
    childOrChildren.dispose();
    removeChildren(element, childOrChildren.array);
    return;
  }
}

function addChildren(element, childOrChildren, before) {
  if (childOrChildren === undefined) {
    return undefined;
  } else if (childOrChildren === null) {
    return null;
  } else if (childOrChildren instanceof Node) {
    const newElement = childOrChildren;
    element.insertBefore(newElement, before);
    return newElement;
  } else if (['string', 'boolean', 'number'].includes(typeof childOrChildren)) {
    const newElement = document.createTextNode(childOrChildren.toString());
    element.insertBefore(newElement, before);
    return newElement;
  } else if (isObservableArray(childOrChildren)) {
    // TODO: Gotta make this work to make things efficient
    const childElements = [];
    return {
      dispose: childOrChildren.observe(changeData => {
        if (changeData.type === 'splice') {
          const elementToAddBefore =
            changeData.index < childElements.length
              ? childElements[changeData.index]
              : before;
          const addedElements = changeData.added.map(child =>
            addChildren(element, child, elementToAddBefore),
          );
          const removed = childElements.splice(
            changeData.index,
            changeData.removedCount,
            ...addedElements,
          );
          removeChildren(element, removed);
        }
      }, true),
      array: childElements,
    };
  } else if (Array.isArray(childOrChildren)) {
    return childOrChildren.map(child => addChildren(element, child, before));
  } else if (typeof childOrChildren === 'function') {
    let previous;
    const positionMarkerElement = document.createComment('');
    element.appendChild(positionMarkerElement);
    reaction(
      childOrChildren,
      next => {
        removeChildren(element, previous);
        previous = addChildren(element, next, positionMarkerElement);
      },
      { fireImmediately: true },
    );
  } else {
    const component = childOrChildren.component;
    const attributes = childOrChildren.attributes;
    const children =
      attributes && attributes.children ? attributes.children : childOrChildren.children;

    const childElementResult = (() => {
      if (typeof component === 'string') {
        const newElement = document.createElement(component);
        assignAttributes(newElement, attributes);
        addChildren(newElement, children, null);
        return newElement;
      } else if (component.prototype instanceof Node) {
        const newElement = new component();
        assignAttributes(newElement, attributes);
        addChildren(newElement, children, null);
        return newElement;
      } else {
        // TODO: This needs to be computed
        return component({ attributes, children });
      }
    })();

    return addChildren(element, childElementResult, before);
  }
}

export function render(element, renderInfo) {
  return addChildren(element, renderInfo, null);
}

export abstract class MobxElement extends HTMLElement {
  constructor() {
    super();
    this.hasInitialized = false;
    this.shadow = this.attachShadow({ mode: 'open' });
    this[PROPS] = observable({});
  }

  public get props() {
    return this[PROPS];
  }

  connectedCallback() {
    this.initialize();
  }

  protected abstract render();

  private initialize() {
    if (!this.hasInitialized) {
      this.hasInitialized = true;
      render(this.shadow, this.render());
    }
  }
}

decorate(MobxElement, {
  render: computed,
});

export function Fragment({ children }) {
  return children;
}

export function createElement(component, attributes, ...children) {
  return { component, attributes, children };
}
