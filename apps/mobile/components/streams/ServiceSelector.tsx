import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  ServiceInfo,
  ServiceCategory,
  CATEGORY_CONFIG,
  searchServices,
  getPopularServices,
  getServicesByCategory,
  getAllCategories,
} from '../../services/subscriptions/serviceRegistry';
import { Colors, FontFamily } from '@/constants/theme';

/**
 * 🎯 RETONED 2026-08-23. This file declared its own palette at the top: a
 * violet the design system does not contain, plus a second constant still
 * carrying the retired pink in its name, and then scattered four more greys and
 * four opaque borders through six hundred lines of inline styles. None of that
 * could be reached by a theme sweep, which is exactly how the app ended up
 * looking like two products from one screen to the next.
 *
 * ⛔ There is one accent, and violet is not it.
 */
const ACCENT = Colors.primary;

interface ServiceSelectorProps {
  selectedService: ServiceInfo | null;
  onSelectService: (service: ServiceInfo | null) => void;
  placeholder?: string;
}

interface ServiceSelectorModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectService: (service: ServiceInfo) => void;
  selectedService: ServiceInfo | null;
}

// Service logo component with fallback
const ServiceLogo: React.FC<{
  service: ServiceInfo;
  size?: number;
  showBorder?: boolean;
}> = ({ service, size = 40, showBorder = false }) => {
  const [imageError, setImageError] = useState(false);

  const backgroundColor = service.color
    ? `${service.color}20`
    : Colors.primaryDim;

  const textColor = service.color || ACCENT;

  // First letter fallback
  const firstLetter = service.name.charAt(0).toUpperCase();

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: showBorder ? 2 : 0,
        borderColor: service.color || ACCENT,
      }}
    >
      {!imageError && service.logo ? (
        <Image
          source={{ uri: service.logo }}
          style={{
            width: size * 0.6,
            height: size * 0.6,
            tintColor: textColor,
          }}
          onError={() => setImageError(true)}
          resizeMode="contain"
        />
      ) : (
        <Text
          style={{
            color: textColor,
            fontFamily: FontFamily.medium,
            fontSize: size * 0.4,
          }}
        >
          {firstLetter}
        </Text>
      )}
    </View>
  );
};

// Individual service item
const ServiceItem: React.FC<{
  service: ServiceInfo;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}> = ({ service, selected, onSelect, compact = false }) => {
  const categoryConfig = CATEGORY_CONFIG[service.category];

  const handlePress = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect();
  };

  if (compact) {
    // Compact horizontal layout for popular services
    return (
      <TouchableOpacity
        onPress={handlePress}
        style={{
          alignItems: 'center',
          width: 72,
          paddingVertical: 8,
        }}
      >
        <ServiceLogo service={service} size={48} showBorder={selected} />
        <Text
          style={{
            color: selected ? Colors.text : Colors.textSecondary,
            fontSize: 11,
            marginTop: 6,
            textAlign: 'center',
          }}
          numberOfLines={1}
        >
          {service.name}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={handlePress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
        backgroundColor: selected ? Colors.primaryDim : 'transparent',
        borderRadius: 12,
        marginBottom: 4,
      }}
    >
      <ServiceLogo service={service} size={44} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ color: Colors.text, fontFamily: FontFamily.medium, fontSize: 15 }}>
          {service.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
          <Ionicons
            name={categoryConfig.icon as any}
            size={12}
            color={categoryConfig.color}
          />
          <Text style={{ color: Colors.textSecondary, fontSize: 12, marginLeft: 4 }}>
            {categoryConfig.label}
          </Text>
        </View>
      </View>
      {selected && (
        <Ionicons name="checkmark-circle" size={24} color={ACCENT} />
      )}
    </TouchableOpacity>
  );
};

// Category filter chip
const CategoryChip: React.FC<{
  category: ServiceCategory | 'all';
  label: string;
  icon: string;
  color: string;
  selected: boolean;
  count?: number;
  onPress: () => void;
}> = ({ category, label, icon, color, selected, count, onPress }) => {
  const handlePress = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 20,
        marginRight: 8,
        backgroundColor: selected ? `${color}30` : Colors.surfaceTertiary,
        borderWidth: 1,
        borderColor: selected ? color : 'transparent',
      }}
    >
      <Ionicons
        name={icon as any}
        size={14}
        color={selected ? color : Colors.textSecondary}
      />
      <Text
        style={{
          color: selected ? color : Colors.textSecondary,
          fontSize: 13,
          fontFamily: FontFamily.medium,
          marginLeft: 6,
        }}
      >
        {label}
      </Text>
      {count !== undefined && (
        <Text
          style={{
            color: selected ? color : Colors.textTertiary,
            fontSize: 11,
            marginLeft: 4,
          }}
        >
          ({count})
        </Text>
      )}
    </TouchableOpacity>
  );
};

// Service selector modal
const ServiceSelectorModal: React.FC<ServiceSelectorModalProps> = ({
  visible,
  onClose,
  onSelectService,
  selectedService,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ServiceCategory | 'all'>('all');

  const categories = useMemo(() => getAllCategories(), []);
  const popularServices = useMemo(() => getPopularServices(), []);

  const filteredServices = useMemo(() => {
    if (searchQuery.length >= 2) {
      return searchServices(searchQuery, 20);
    }

    if (selectedCategory === 'all') {
      return [];
    }

    return getServicesByCategory(selectedCategory);
  }, [searchQuery, selectedCategory]);

  const handleSelectService = useCallback((service: ServiceInfo) => {
    onSelectService(service);
    onClose();
    setSearchQuery('');
    setSelectedCategory('all');
  }, [onSelectService, onClose]);

  const handleClose = useCallback(() => {
    onClose();
    setSearchQuery('');
    setSelectedCategory('all');
  }, [onClose]);

  const showPopular = searchQuery.length < 2 && selectedCategory === 'all';
  const showResults = searchQuery.length >= 2 || selectedCategory !== 'all';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={{ flex: 1, backgroundColor: Colors.background }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: Colors.border,
          }}
        >
          <TouchableOpacity onPress={handleClose}>
            <Ionicons name="close" size={24} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={{ color: Colors.text, fontSize: 17, fontFamily: FontFamily.medium }}>
            Select Service
          </Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Search Input */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: Colors.surfaceTertiary,
              borderRadius: 12,
              paddingHorizontal: 12,
              height: 44,
            }}
          >
            <Ionicons name="search" size={20} color={Colors.textSecondary} />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search services..."
              placeholderTextColor={Colors.textTertiary}
              style={{
                flex: 1,
                color: Colors.text,
                fontSize: 15,
                marginLeft: 8,
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Category Filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingVertical: 12,
          }}
        >
          <CategoryChip
            category="all"
            label="All"
            icon="apps"
            color={ACCENT}
            selected={selectedCategory === 'all'}
            onPress={() => setSelectedCategory('all')}
          />
          {categories.map(({ category, count, config }) => (
            <CategoryChip
              key={category}
              category={category}
              label={config.label}
              icon={config.icon}
              color={config.color}
              count={count}
              selected={selectedCategory === category}
              onPress={() => setSelectedCategory(category)}
            />
          ))}
        </ScrollView>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Popular Services Section */}
          {showPopular && (
            <View style={{ paddingHorizontal: 16 }}>
              <Text
                style={{
                  color: Colors.textSecondary,
                  fontSize: 13,
                  fontFamily: FontFamily.medium,
                  marginBottom: 12,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                Popular Services
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingRight: 16 }}
              >
                {popularServices.map(service => (
                  <ServiceItem
                    key={service.id}
                    service={service}
                    selected={selectedService?.id === service.id}
                    onSelect={() => handleSelectService(service)}
                    compact
                  />
                ))}
              </ScrollView>

              <Text
                style={{
                  color: Colors.textTertiary,
                  fontSize: 13,
                  marginTop: 24,
                  textAlign: 'center',
                }}
              >
                Search or select a category to browse all services
              </Text>
            </View>
          )}

          {/* Search/Filter Results */}
          {showResults && (
            <View style={{ paddingHorizontal: 8 }}>
              {filteredServices.length > 0 ? (
                <>
                  <Text
                    style={{
                      color: Colors.textSecondary,
                      fontSize: 12,
                      marginLeft: 8,
                      marginBottom: 8,
                    }}
                  >
                    {filteredServices.length} service{filteredServices.length !== 1 ? 's' : ''} found
                  </Text>
                  {filteredServices.map(service => (
                    <ServiceItem
                      key={service.id}
                      service={service}
                      selected={selectedService?.id === service.id}
                      onSelect={() => handleSelectService(service)}
                    />
                  ))}
                </>
              ) : (
                <View
                  style={{
                    alignItems: 'center',
                    paddingVertical: 40,
                  }}
                >
                  <Ionicons name="search-outline" size={48} color={Colors.textTertiary} />
                  <Text
                    style={{
                      color: Colors.textSecondary,
                      fontSize: 15,
                      marginTop: 12,
                    }}
                  >
                    No services found
                  </Text>
                  <Text
                    style={{
                      color: Colors.textTertiary,
                      fontSize: 13,
                      marginTop: 4,
                    }}
                  >
                    Try a different search term
                  </Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* Skip/Custom Service Option */}
        <View
          style={{
            padding: 16,
            borderTopWidth: 1,
            borderTopColor: Colors.border,
          }}
        >
          <TouchableOpacity
            onPress={handleClose}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 12,
            }}
          >
            <Ionicons name="add-circle-outline" size={20} color={Colors.textSecondary} />
            <Text
              style={{
                color: Colors.textSecondary,
                fontSize: 14,
                marginLeft: 8,
              }}
            >
              Skip - Use custom service name
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

// Main ServiceSelector component
export const ServiceSelector: React.FC<ServiceSelectorProps> = ({
  selectedService,
  onSelectService,
  placeholder = 'Select a service (optional)',
}) => {
  const [modalVisible, setModalVisible] = useState(false);

  const handleOpenModal = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(true);
  };

  const handleSelectService = (service: ServiceInfo) => {
    onSelectService(service);
  };

  const handleClearService = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelectService(null);
  };

  return (
    <>
      <TouchableOpacity
        onPress={handleOpenModal}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: Colors.surface,
          borderWidth: 1,
          borderColor: selectedService
            ? `${selectedService.color || ACCENT}50`
            : Colors.border,
          borderRadius: 12,
          padding: 12,
        }}
      >
        {selectedService ? (
          <>
            <ServiceLogo service={selectedService} size={40} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ color: Colors.text, fontFamily: FontFamily.medium, fontSize: 15 }}>
                {selectedService.name}
              </Text>
              <Text style={{ color: Colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                {CATEGORY_CONFIG[selectedService.category].label}
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleClearService}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{
                padding: 4,
              }}
            >
              <Ionicons name="close-circle" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: Colors.primaryDim,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="apps-outline" size={20} color={ACCENT} />
            </View>
            <Text
              style={{
                flex: 1,
                color: Colors.textTertiary,
                fontSize: 15,
                marginLeft: 12,
              }}
            >
              {placeholder}
            </Text>
            <Ionicons name="chevron-forward" size={20} color={Colors.textSecondary} />
          </>
        )}
      </TouchableOpacity>

      <ServiceSelectorModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onSelectService={handleSelectService}
        selectedService={selectedService}
      />
    </>
  );
};

// Export ServiceLogo for use in other components
export { ServiceLogo };

export default ServiceSelector;
