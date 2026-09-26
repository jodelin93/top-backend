import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixRelationJoinColumns1790270099416 implements MigrationInterface {
  name = 'FixRelationJoinColumns1790270099416';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouses" DROP CONSTRAINT "FK_09106b8068aeaf74fa33666df8f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP CONSTRAINT "FK_83abf141eab6cd74db8eaced29d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP CONSTRAINT "FK_b89597faae660724b796ff4b572"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_b923656be8487cea6434cb56a08"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_6da077559e6c8a8fcc4893b790f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_e80e7e392753f6aafdd45bc05c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "branches" DROP CONSTRAINT "FK_fda619979f40a6a44fc9baf02c3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP CONSTRAINT "FK_d22937ebccd641b5090849e51f7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP CONSTRAINT "FK_7427b391abdef33b40124c15822"`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" DROP CONSTRAINT "FK_5d4fe23b360b1b9e16a3f41727f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_9c365ebf78f0e8a6d9e4827ea70"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_860485c46a817f4b075a7a3265b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_553196ea54b383f352401962af2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_631868eaa78af7cf2bd30b092e7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_1105dbf21d189f0d5351331a989"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_acbe2d50e7f46c0f06ac34ee819"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_6fc6f7c307e4bf07e08c5e4a9b0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" DROP CONSTRAINT "FK_7a18ded923b3ce8fde8338c2b31"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_b1b3176b27d1190616e8ac02109"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_e2eea482af20ddb49c8f9cfd710"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_ef13c0725838fde279f29831217"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" DROP CONSTRAINT "FK_e65eddc13f0cb1694ce740dc6b7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_9109b53fca5cef7720aca72974d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_778b09e1333bd4c0fd8aad37a73"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_12fd861c33c885f01b9a7da7d93"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_ae6cc7812b56c7a03599a407d90"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_acd4c1095487898fdce94c3d31e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_2fcbd760528adf030fe3bf86416"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_c51005b2b06cec7aa17462c54f5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_5f282f3656814ec9ca2675aef6f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_b5f573f9bb2f26179da6d6f7711"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "FK_97913f35ac2e435a4463fb50a01"`,
    );
    await queryRunner.query(
      `ALTER TABLE "discounts" DROP CONSTRAINT "FK_881f8f8ab71335fb8e3cd5703e9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP CONSTRAINT "FK_35de7c0f11722fb48e2b09a466f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP CONSTRAINT "FK_367e5805317457739acfb681551"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_97a9abbc5b4372cfb15efe9eb13"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_545dca0ee9afd3f176ceab62e87"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_cecef093f501fe692704f23f370"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_866b999f190dfdec5a077e1abc5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_42e03e8288b4c27af35dcd4b1c9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" DROP CONSTRAINT "FK_b0d0350059126fa08fddc3c7a46"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_237678c98436e0abb48b3060c82"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_d16a885aa88447ccfd010e739b0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_4deb35e7eb5f6002a09dc43d9c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_c13036093717212c2c6aa111c73"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_0f5b7d10c33fd6432f7b2636045"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_00cb491bb39ad41fdd0863f0475"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_7c8982651b3e47e1c30dc1457d3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_f88dacd92b4cc8d5a48a8c19994"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_27a1a2048d35e2bbe421f302e33"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_a6e8e9bb147339f4bb77147863b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_703e27532235de1937132c8ab47"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_fbf4e99328422e7a889c06a7016"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_232c2100e981260bf8ca5a98773"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_30dd9acc22dcb6ae51d7d34f16d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_ede9170736a1fcf13d4c23792a1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_011d2db0f22096952c6b3309c38"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_4a1e05185a0ffe45994c5d9dacd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_d7fedfd6ee0f4a06648c48631c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_rates" DROP CONSTRAINT "FK_9675366aed16a56e6c9322805f4"`,
    );
    await queryRunner.query(`ALTER TABLE "warehouses" DROP COLUMN "tenant_id"`);
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP COLUMN "warehouse_id"`,
    );
    await queryRunner.query(`ALTER TABLE "registers" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "registers" DROP COLUMN "branch_id"`);
    await queryRunner.query(
      `ALTER TABLE "registers" DROP COLUMN "default_location_id"`,
    );
    await queryRunner.query(`ALTER TABLE "branches" DROP COLUMN "tenant_id"`);
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP COLUMN "user_id"`,
    );
    await queryRunner.query(`ALTER TABLE "categories" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "category_id"`);
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "product_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP COLUMN "variant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP COLUMN "attribute_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(`ALTER TABLE "sale_items" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "sale_items" DROP COLUMN "sale_id"`);
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP COLUMN "variant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "sale_id"`);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "payment_method_id"`,
    );
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "branch_id"`);
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "register_id"`);
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "customer_id"`);
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "user_id"`);
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "parent_sale_id"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "tenant_id"`);
    await queryRunner.query(`ALTER TABLE "discounts" DROP COLUMN "tenant_id"`);
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP COLUMN "branch_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP COLUMN "price_list_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP COLUMN "variant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "product_id"`,
    );
    await queryRunner.query(`ALTER TABLE "suppliers" DROP COLUMN "tenant_id"`);
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP COLUMN "supplier_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP COLUMN "warehouse_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP COLUMN "user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP COLUMN "purchase_order_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP COLUMN "variant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP COLUMN "location_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP COLUMN "user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP COLUMN "variant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP COLUMN "location_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN "user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN "tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN "variant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN "from_location_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN "to_location_id"`,
    );
    await queryRunner.query(`ALTER TABLE "tax_rates" DROP COLUMN "tenant_id"`);
    await queryRunner.query(
      `ALTER TABLE "warehouses" ADD CONSTRAINT "FK_c747b0a69a22b026c99bac8b100" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD CONSTRAINT "FK_a2302ce1b6237d23259d52f7681" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD CONSTRAINT "FK_4cd8e461f529ea2d437f9fe8fcd" FOREIGN KEY ("warehouseId", "tenantId") REFERENCES "warehouses"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_72da1931ed00ada37715d81f8bb" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_36fd93208f00fa77d5a5f96a35c" FOREIGN KEY ("branchId", "tenantId") REFERENCES "branches"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_76efcb3ac796b1b764b2f5af3ce" FOREIGN KEY ("defaultLocationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "branches" ADD CONSTRAINT "FK_19db6a12993aa421cc984376635" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD CONSTRAINT "FK_f2a716ce4ea37745564baaccda3" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD CONSTRAINT "FK_aff7ff5f171848da8169885b857" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" ADD CONSTRAINT "FK_46a85229c9953b2b94f768190b2" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_6804855ba1a19523ea57e0769b4" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_60641843a69bd415aa8840e30f2" FOREIGN KEY ("categoryId", "tenantId") REFERENCES "categories"("id","tenantId") ON DELETE SET NULL ("categoryId") ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_cb549293071d118e0d19a89eb2e" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_6e1ac38c1613e342b780db4ea76" FOREIGN KEY ("productId", "tenantId") REFERENCES "products"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_41b39e922cbfe5d74ef088531f7" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_fc2030b08be84e113aa0c518d66" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_972a0a44bdaaf4c1a44db50bfe8" FOREIGN KEY ("attributeId", "tenantId") REFERENCES "attribute_definitions"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" ADD CONSTRAINT "FK_a1d344b5c8c15f564d099f6bec6" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_59bf1a657943f7ba75eeef920ef" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_7da6d3be960f8b8dff13abad82a" FOREIGN KEY ("saleId", "tenantId") REFERENCES "sales"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_23864722dd093646e85214f6be4" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" ADD CONSTRAINT "FK_5806b0d1820c6ae8c880ca42048" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_98a04cdcbac4f6a2c55c7d19350" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_33096b139cdf57ed14517c1cb94" FOREIGN KEY ("saleId", "tenantId") REFERENCES "sales"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_cbe18cae039006a9c217d5a66a6" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_37606c7b1560c6be428c7a48959" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_3d1ea8bf2f7d265e748550bfccb" FOREIGN KEY ("branchId", "tenantId") REFERENCES "branches"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_4bc54d6ef4124246ab60cf1e0bc" FOREIGN KEY ("registerId") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_3a92cf6add00043cef9833db1cd" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_52ff6cd9431cc7687c76f935938" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_7a19887c4de060fff9418e4c800" FOREIGN KEY ("parentSaleId", "tenantId") REFERENCES "sales"("id","tenantId") ON DELETE SET NULL ("parentSaleId") ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_37c1a605468d156e6a8f78f1dc5" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "discounts" ADD CONSTRAINT "FK_eeaeeb128b5903372636b1c3bfb" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" ADD CONSTRAINT "FK_02d8838ac5cd6133a7fff466f43" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" ADD CONSTRAINT "FK_020c20d3d13f303bfa51e9f601f" FOREIGN KEY ("branchId", "tenantId") REFERENCES "branches"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_73c3ae7a509e6f16989d05c3cfb" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_8c1f34e03d525e7f852748a5a25" FOREIGN KEY ("priceListId", "tenantId") REFERENCES "price_lists"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_5df8cd346baa0f5149d82a7bc1c" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_afd3202e7e6d23df6660dca2acf" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_d5f8eacc4ee3fa0dbb325ddc122" FOREIGN KEY ("productId", "tenantId") REFERENCES "products"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" ADD CONSTRAINT "FK_dd5cd678c4e94ddb93a224e7116" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_299ed1b81cad44317acbf02bab9" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_0c3ff892a9f2ed16f59d31cccae" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_dbd4c2fa47dda90b96b2ca090a0" FOREIGN KEY ("warehouseId", "tenantId") REFERENCES "warehouses"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_19c934e5dc27110448bc8e7cbd8" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_1e46ec8256e97336689eacbaaa0" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_dbb2d4acae374dc7b334a99b82a" FOREIGN KEY ("purchaseOrderId", "tenantId") REFERENCES "purchase_orders"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_89905883e5ab2e73bf288e42737" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_20404b71a1380c6083dcf76e7d1" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_39d711946c26d22aff6f42f3128" FOREIGN KEY ("locationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_4f4b10e09fa893066e7ac007075" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_7aa2d853d19f3df3a890aa791f0" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_a4d651d522da10b1fcbbafda43e" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_98845f5c73b414283081131b0de" FOREIGN KEY ("locationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_7dde280faf0d06b5b1b067b8ac1" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_1f33818c5a62acc7e82b9edac5e" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_858a833ca806acadd845030e682" FOREIGN KEY ("fromLocationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_57be8a081052a2b4019524f781b" FOREIGN KEY ("toLocationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_4fc9f6fc2db22fc301f7c1c918b" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_rates" ADD CONSTRAINT "FK_f3b8fedd11b19143dd32287b6aa" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tax_rates" DROP CONSTRAINT "FK_f3b8fedd11b19143dd32287b6aa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_4fc9f6fc2db22fc301f7c1c918b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_57be8a081052a2b4019524f781b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_858a833ca806acadd845030e682"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_1f33818c5a62acc7e82b9edac5e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_7dde280faf0d06b5b1b067b8ac1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_98845f5c73b414283081131b0de"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_a4d651d522da10b1fcbbafda43e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_7aa2d853d19f3df3a890aa791f0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_4f4b10e09fa893066e7ac007075"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_39d711946c26d22aff6f42f3128"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_20404b71a1380c6083dcf76e7d1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_89905883e5ab2e73bf288e42737"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_dbb2d4acae374dc7b334a99b82a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_1e46ec8256e97336689eacbaaa0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_19c934e5dc27110448bc8e7cbd8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_dbd4c2fa47dda90b96b2ca090a0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_0c3ff892a9f2ed16f59d31cccae"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_299ed1b81cad44317acbf02bab9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" DROP CONSTRAINT "FK_dd5cd678c4e94ddb93a224e7116"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_d5f8eacc4ee3fa0dbb325ddc122"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_afd3202e7e6d23df6660dca2acf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_5df8cd346baa0f5149d82a7bc1c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_8c1f34e03d525e7f852748a5a25"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_73c3ae7a509e6f16989d05c3cfb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP CONSTRAINT "FK_020c20d3d13f303bfa51e9f601f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP CONSTRAINT "FK_02d8838ac5cd6133a7fff466f43"`,
    );
    await queryRunner.query(
      `ALTER TABLE "discounts" DROP CONSTRAINT "FK_eeaeeb128b5903372636b1c3bfb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "FK_37c1a605468d156e6a8f78f1dc5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_7a19887c4de060fff9418e4c800"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_52ff6cd9431cc7687c76f935938"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_3a92cf6add00043cef9833db1cd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_4bc54d6ef4124246ab60cf1e0bc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_3d1ea8bf2f7d265e748550bfccb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_37606c7b1560c6be428c7a48959"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_cbe18cae039006a9c217d5a66a6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_33096b139cdf57ed14517c1cb94"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_98a04cdcbac4f6a2c55c7d19350"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" DROP CONSTRAINT "FK_5806b0d1820c6ae8c880ca42048"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_23864722dd093646e85214f6be4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_7da6d3be960f8b8dff13abad82a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_59bf1a657943f7ba75eeef920ef"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" DROP CONSTRAINT "FK_a1d344b5c8c15f564d099f6bec6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_972a0a44bdaaf4c1a44db50bfe8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_fc2030b08be84e113aa0c518d66"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_41b39e922cbfe5d74ef088531f7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_6e1ac38c1613e342b780db4ea76"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_cb549293071d118e0d19a89eb2e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_60641843a69bd415aa8840e30f2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_6804855ba1a19523ea57e0769b4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" DROP CONSTRAINT "FK_46a85229c9953b2b94f768190b2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP CONSTRAINT "FK_aff7ff5f171848da8169885b857"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP CONSTRAINT "FK_f2a716ce4ea37745564baaccda3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "branches" DROP CONSTRAINT "FK_19db6a12993aa421cc984376635"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_76efcb3ac796b1b764b2f5af3ce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_36fd93208f00fa77d5a5f96a35c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_72da1931ed00ada37715d81f8bb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP CONSTRAINT "FK_4cd8e461f529ea2d437f9fe8fcd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP CONSTRAINT "FK_a2302ce1b6237d23259d52f7681"`,
    );
    await queryRunner.query(
      `ALTER TABLE "warehouses" DROP CONSTRAINT "FK_c747b0a69a22b026c99bac8b100"`,
    );
    await queryRunner.query(`ALTER TABLE "tax_rates" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD "to_location_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD "from_location_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD "variant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "stock_movements" ADD "user_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD "location_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "stock_levels" ADD "variant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "stock_levels" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD "user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD "location_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD "variant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD "purchase_order_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "purchase_orders" ADD "user_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD "warehouse_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD "supplier_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "suppliers" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD "product_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD "variant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD "price_list_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "price_entries" ADD "tenant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "price_lists" ADD "branch_id" uuid`);
    await queryRunner.query(`ALTER TABLE "price_lists" ADD "tenant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "discounts" ADD "tenant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "customers" ADD "tenant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sales" ADD "parent_sale_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sales" ADD "user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sales" ADD "customer_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sales" ADD "register_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sales" ADD "branch_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sales" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "payment_method_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "payments" ADD "sale_id" uuid`);
    await queryRunner.query(`ALTER TABLE "payments" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "payment_methods" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "sale_items" ADD "variant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sale_items" ADD "sale_id" uuid`);
    await queryRunner.query(`ALTER TABLE "sale_items" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD "attribute_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD "variant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD "product_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "products" ADD "category_id" uuid`);
    await queryRunner.query(`ALTER TABLE "products" ADD "tenant_id" uuid`);
    await queryRunner.query(`ALTER TABLE "categories" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD "user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "branches" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "registers" ADD "default_location_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "registers" ADD "branch_id" uuid`);
    await queryRunner.query(`ALTER TABLE "registers" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD "warehouse_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD "tenant_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "warehouses" ADD "tenant_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "tax_rates" ADD CONSTRAINT "FK_9675366aed16a56e6c9322805f4" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_d7fedfd6ee0f4a06648c48631c6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_4a1e05185a0ffe45994c5d9dacd" FOREIGN KEY ("to_location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_011d2db0f22096952c6b3309c38" FOREIGN KEY ("from_location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_ede9170736a1fcf13d4c23792a1" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_30dd9acc22dcb6ae51d7d34f16d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_232c2100e981260bf8ca5a98773" FOREIGN KEY ("location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_fbf4e99328422e7a889c06a7016" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_703e27532235de1937132c8ab47" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_a6e8e9bb147339f4bb77147863b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_27a1a2048d35e2bbe421f302e33" FOREIGN KEY ("location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_f88dacd92b4cc8d5a48a8c19994" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_7c8982651b3e47e1c30dc1457d3" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_00cb491bb39ad41fdd0863f0475" FOREIGN KEY ("purchase_order_id", "tenant_id") REFERENCES "purchase_orders"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_0f5b7d10c33fd6432f7b2636045" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_c13036093717212c2c6aa111c73" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_4deb35e7eb5f6002a09dc43d9c6" FOREIGN KEY ("warehouse_id", "tenant_id") REFERENCES "warehouses"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_d16a885aa88447ccfd010e739b0" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_237678c98436e0abb48b3060c82" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" ADD CONSTRAINT "FK_b0d0350059126fa08fddc3c7a46" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_42e03e8288b4c27af35dcd4b1c9" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "products"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_866b999f190dfdec5a077e1abc5" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_cecef093f501fe692704f23f370" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_545dca0ee9afd3f176ceab62e87" FOREIGN KEY ("price_list_id", "tenant_id") REFERENCES "price_lists"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_97a9abbc5b4372cfb15efe9eb13" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" ADD CONSTRAINT "FK_367e5805317457739acfb681551" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branches"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" ADD CONSTRAINT "FK_35de7c0f11722fb48e2b09a466f" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "discounts" ADD CONSTRAINT "FK_881f8f8ab71335fb8e3cd5703e9" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_97913f35ac2e435a4463fb50a01" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_b5f573f9bb2f26179da6d6f7711" FOREIGN KEY ("parent_sale_id", "tenant_id") REFERENCES "sales"("id","tenantId") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_5f282f3656814ec9ca2675aef6f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_c51005b2b06cec7aa17462c54f5" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_2fcbd760528adf030fe3bf86416" FOREIGN KEY ("register_id") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_acd4c1095487898fdce94c3d31e" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branches"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_ae6cc7812b56c7a03599a407d90" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_12fd861c33c885f01b9a7da7d93" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_778b09e1333bd4c0fd8aad37a73" FOREIGN KEY ("sale_id", "tenant_id") REFERENCES "sales"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_9109b53fca5cef7720aca72974d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" ADD CONSTRAINT "FK_e65eddc13f0cb1694ce740dc6b7" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_ef13c0725838fde279f29831217" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_e2eea482af20ddb49c8f9cfd710" FOREIGN KEY ("sale_id", "tenant_id") REFERENCES "sales"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_b1b3176b27d1190616e8ac02109" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" ADD CONSTRAINT "FK_7a18ded923b3ce8fde8338c2b31" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_6fc6f7c307e4bf07e08c5e4a9b0" FOREIGN KEY ("attribute_id", "tenant_id") REFERENCES "attribute_definitions"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_acbe2d50e7f46c0f06ac34ee819" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_1105dbf21d189f0d5351331a989" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_631868eaa78af7cf2bd30b092e7" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "products"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_553196ea54b383f352401962af2" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_860485c46a817f4b075a7a3265b" FOREIGN KEY ("category_id", "tenant_id") REFERENCES "categories"("id","tenantId") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_9c365ebf78f0e8a6d9e4827ea70" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" ADD CONSTRAINT "FK_5d4fe23b360b1b9e16a3f41727f" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD CONSTRAINT "FK_7427b391abdef33b40124c15822" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD CONSTRAINT "FK_d22937ebccd641b5090849e51f7" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "branches" ADD CONSTRAINT "FK_fda619979f40a6a44fc9baf02c3" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_e80e7e392753f6aafdd45bc05c6" FOREIGN KEY ("default_location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_6da077559e6c8a8fcc4893b790f" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branches"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_b923656be8487cea6434cb56a08" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD CONSTRAINT "FK_b89597faae660724b796ff4b572" FOREIGN KEY ("warehouse_id", "tenant_id") REFERENCES "warehouses"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD CONSTRAINT "FK_83abf141eab6cd74db8eaced29d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "warehouses" ADD CONSTRAINT "FK_09106b8068aeaf74fa33666df8f" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
