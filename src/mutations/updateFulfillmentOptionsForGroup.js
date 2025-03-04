import _ from "lodash";
import SimpleSchema from "simpl-schema";
import ReactionError from "@reactioncommerce/reaction-error";
import getCartById from "../util/getCartById.js";

const inputSchema = new SimpleSchema({
  cartId: String,
  cartToken: {
    type: String,
    optional: true,
  },
  fulfillmentGroupId: String,
});

/**
 * @name getShipmentQuotesQueryStatus
 * @param  {Array} rates    Rate array
 * @returns {Object} An object with `shipmentQuotes` and `shipmentQuotesQueryStatus` on it
 * @private
 */
function getShipmentQuotesQueryStatus(rates) {
  if (rates.length === 0) {
    return {
      shipmentQuotes: [],
      shipmentQuotesQueryStatus: {
        requestStatus: "pending",
      },
    };
  }

  const errorResult = rates.find((option) => option.requestStatus === "error");
  if (errorResult) {
    return {
      shipmentQuotes: [],
      shipmentQuotesQueryStatus: {
        requestStatus: errorResult.requestStatus,
        shippingProvider: errorResult.shippingProvider,
        message: errorResult.message,
      },
    };
  }

  return {
    shipmentQuotes: rates,
    shipmentQuotesQueryStatus: {
      requestStatus: "success",
      numOfShippingMethodsFound: rates.length,
    },
  };
}

const _getShippingFree = (shipmentQuotes) => {
  const freeQuote = shipmentQuotes.find(
    (group2) => group2.method.group === "Free"
  );
  if (freeQuote) {
    return freeQuote.method;
  } else {
    throw new ReactionError(
      "not-found-free-quotes",
      `No se ha agregado los métodos gratuitos`
    );
  }
};

/**
 * @method updateFulfillmentOptionsForGroup
 * @summary Updates the fulfillment quotes for a fulfillment group
 * @param {Object} context -  an object containing the per-request state
 * @param {Object} input - an object of all mutation arguments that were sent by the client
 * @param {String} input.cartId - The ID of the cart to update fulfillment options for
 * @param {String} [input.cartToken] - The token for the cart, required if it is an anonymous cart
 * @param {String} input.fulfillmentGroupId - The group to update fulfillment options for
 * @returns {Promise<Object>} An object with a `cart` property containing the updated cart
 */
export default async function updateFulfillmentOptionsForGroup(context, input) {
  const cleanedInput = inputSchema.clean(input || {});
  inputSchema.validate(cleanedInput);

  const { cartId, cartToken, fulfillmentGroupId } = cleanedInput;

  const cart = await getCartById(context, cartId, {
    cartToken,
    throwIfNotFound: true,
  });

  // This is done by `saveCart`, too, but we need to do it before every call to `getCommonOrderForCartGroup`
  // to avoid errors in the case where a product has been deleted since the last time this cart was saved.
  // This mutates that `cart` object.
  await context.mutations.removeMissingItemsFromCart(context, cart);

  const fulfillmentGroup = (cart.shipping || []).find(
    (group) => group._id === fulfillmentGroupId
  );
  if (!fulfillmentGroup)
    throw new ReactionError(
      "not-found",
      `Fulfillment group with ID ${fulfillmentGroupId} not found in cart with ID ${cartId}`
    );

  const commonOrder = await context.queries.getCommonOrderForCartGroup(
    context,
    { cart, fulfillmentGroupId: fulfillmentGroup._id }
  );

  // In the future we want to do this async and subscribe to the results
  const rates = await context.queries.getFulfillmentMethodsWithQuotes(
    commonOrder,
    context
  );

  const { shipmentQuotes, shipmentQuotesQueryStatus } =
    getShipmentQuotesQueryStatus(rates);
  //if (!_.isEqual(shipmentQuotes, fulfillmentGroup.shipmentQuotes) || !_.isEqual(shipmentQuotesQueryStatus, fulfillmentGroup.shipmentQuotesQueryStatus)) {

  const updatedCart = {
    ...cart,
    shipping: cart.shipping.map((group) => {
      if (group._id === fulfillmentGroupId) {
        let shipmentMethod = null;
        if (group.type === "pickup") {
          shipmentMethod = _getShippingFree(shipmentQuotes);
        } else if (group.address) {
          let cost = 0;
          try {
            cost = cart.items.reduce((previousValue, currentValue) => {
              return {
                subtotal: {
                  amount:
                    previousValue.subtotal.amount +
                    currentValue.subtotal.amount,
                },
              };
            }).subtotal.amount;
          } catch (ex2) {}
          if (cost <= 150) {
            const groundQuotes = shipmentQuotes.filter(
              (group2) => group2.method.group === "Ground"
            );
            if (groundQuotes.length == 0) {
              throw new ReactionError(
                "not-found-ground-quotes",
                `No se ha agregado los métodos de cobros de envíos`
              );
            }
            groundQuotes.sort((a, b) => a.handlingPrice - b.handlingPrice);
            let circleQuote = groundQuotes.find(
              (group2) =>
                group.address.metaddress.distance.value <= group2.handlingPrice
            );
            if (circleQuote) {
              shipmentMethod = circleQuote.method;
            } else {
              shipmentMethod = undefined;
            }
          } else {
            shipmentMethod = _getShippingFree(shipmentQuotes);
          }
        }
        if (shipmentMethod !== null) {
          return {
            ...group,
            shipmentQuotes,
            shipmentQuotesQueryStatus,
            shipmentMethod,
          };
        } else {
          return { ...group, shipmentQuotes, shipmentQuotesQueryStatus };
        }
      }
      return group;
    }),
    updatedAt: new Date(),
  };

  const savedCart = await context.mutations.saveCart(context, updatedCart);

  return { cart: savedCart };
  //}
  //return { cart };
}
