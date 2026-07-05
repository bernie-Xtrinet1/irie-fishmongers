# Build Products Module

## Objective
Create product catalog management for fish vendors.

## Features

### Vendor Functions
- Create product
- Edit product
- Delete product
- Upload images
- Manage inventory
- Set availability

### Product Data

- Product Name
- Fish Type
- Description
- Weight
- Price
- Quantity Available
- Vendor ID
- Product Images
- Status

### Customer Functions

- Browse products
- Search products
- Filter products
- View product details

### API Endpoints

GET /products
GET /products/:id
POST /products
PATCH /products/:id
DELETE /products/:id

### Database Tables

products
product_images
inventory

### Deliverables

- Database schema
- APIs
- Validation
- Unit tests
- Integration tests
